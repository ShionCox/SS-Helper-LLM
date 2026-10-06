/**
 * 消费方注册中心
 * 职责：
 * - 幂等 upsert 注册（支持先启动后挂载、热更新、禁用再启用、重复覆盖）
 * - 持久字段与会话字段分离
 * - 只读查询 API
 *
 * 注册接口是同步命令式；内部持久化、广播、异步落盘由注册中心自己排程处理。
 */

import { logger, safeFailureLogDetail } from '../runtime/logger';
import type {
    ConsumerRegistration,
    ConsumerPersistentSnapshot,
    ConsumerSessionSnapshot,
    ConsumerSnapshot,
    TaskDescriptor,
} from '../schema/types';


type ConsumerRegistryListener = () => void;

export class ConsumerRegistry {
    /** 持久快照 */
    private persistent: Map<string, ConsumerPersistentSnapshot> = new Map();
    /** 会话快照 */
    private sessions: Map<string, ConsumerSessionSnapshot> = new Map();

    /** 外部注入的持久化回调（由 LLMHub 主类设置） */
    private persistCallback: ((snapshots: Record<string, ConsumerPersistentSnapshot>) => void | Promise<void>) | null = null;
    /** 只读变更监听器 */
    private listeners: Set<ConsumerRegistryListener> = new Set();
    /** 本次会话中明确注销的插件，防止旧持久快照把它重新带回。 */
    private readonly released = new Set<string>();

    // ─── 初始化与恢复 ───

    /** 从持久存储恢复（仅恢复持久字段，不恢复会话态） */
    restoreFromStorage(snapshots: Record<string, ConsumerPersistentSnapshot>): void {
        for (const [pluginId, snapshot] of Object.entries(snapshots)) {
            if (this.released.has(pluginId)) continue;
            const live = this.sessions.get(pluginId);
            if (live?.online === true) continue;
            this.persistent.set(pluginId, { ...snapshot });
            // 会话字段初始化为离线
            this.sessions.set(pluginId, this.createOfflineSession());
        }
        logger.info(`从持久存储恢复了 ${this.persistent.size} 个消费方注册。`);
        this.notifyListeners();
    }

    /** 设置持久化回调 */
    setPersistCallback(cb: (snapshots: Record<string, ConsumerPersistentSnapshot>) => void | Promise<void>): void {
        this.persistCallback = cb;
    }

    /**
     * 功能：订阅 consumer 注册表的只读变化事件。
     * 参数：
     *   listener：变化后需要调用的监听器。
     * 返回：
     *   () => void：取消订阅函数。
     */
    subscribe(listener: ConsumerRegistryListener): () => void {
        this.listeners.add(listener);
        return (): void => {
            this.listeners.delete(listener);
        };
    }

    // ─── 核心注册接口（同步命令式） ───

    /**
     * 幂等 upsert 注册。
     * 同步返回，内部异步落盘。
     */
    registerConsumer(registration: ConsumerRegistration): void {
        const { pluginId, displayName, registrationVersion, tasks } = registration;
        this.released.delete(pluginId);

        const snapshot: ConsumerPersistentSnapshot = {
            pluginId,
            displayName,
            registrationVersion,
            tasks: [...tasks],
        };

        this.persistent.set(pluginId, snapshot);

        // 更新会话为在线
        this.sessions.set(pluginId, {
            online: true,
            seenAt: Date.now(),
        });

        logger.info(`消费方 ${pluginId} (v${registrationVersion}) 注册成功，${tasks.length} 个任务。`);
        this.notifyListeners();

        // 异步落盘
        this.schedulePersist();
    }

    /**
     * 注销消费方。
     * 同步返回，内部异步落盘。
     */
    unregisterConsumer(pluginId: string, opts?: { keepPersistent?: boolean }): void {
        this.released.add(pluginId);
        if (!opts?.keepPersistent) {
            this.persistent.delete(pluginId);
        }

        // 会话置为离线
        const session = this.sessions.get(pluginId);
        if (session) {
            session.online = false;
        }

        logger.info(`消费方 ${pluginId} 已注销${opts?.keepPersistent ? '（保留持久数据）' : ''}。`);
        this.notifyListeners();
        this.schedulePersist();
    }

    // ─── 只读查询 ───

    getConsumerRegistration(pluginId: string): ConsumerSnapshot | null {
        const persistent = this.persistent.get(pluginId);
        if (!persistent) return null;
        const session = this.sessions.get(pluginId) || this.createOfflineSession();
        return { ...persistent, session };
    }

    listConsumerRegistrations(): ConsumerSnapshot[] {
        const result: ConsumerSnapshot[] = [];
        for (const [pluginId, persistent] of this.persistent) {
            const session = this.sessions.get(pluginId) || this.createOfflineSession();
            result.push({ ...persistent, session });
        }
        return result;
    }

    /** 获取某插件某任务的描述 */
    getTaskDescriptor(pluginId: string, taskKey: string): TaskDescriptor | undefined {
        return this.persistent.get(pluginId)?.tasks.find(t => t.taskKey === taskKey);
    }

    /** 检查插件是否在线 */
    isOnline(pluginId: string): boolean {
        return this.sessions.get(pluginId)?.online === true;
    }

    // ─── 导出快照供持久化 ───

    exportPersistentSnapshots(): Record<string, ConsumerPersistentSnapshot> {
        const result: Record<string, ConsumerPersistentSnapshot> = {};
        for (const [pluginId, snapshot] of this.persistent) {
            result[pluginId] = { ...snapshot };
        }
        return result;
    }

    // ─── 内部方法 ───

    private createOfflineSession(): ConsumerSessionSnapshot {
        return {
            online: false,
            seenAt: 0,
        };
    }

    /**
     * 功能：通知所有只读监听器注册表已经变化。
     * 返回：
     *   void：无返回值。
     */
    private notifyListeners(): void {
        this.listeners.forEach((listener: ConsumerRegistryListener): void => {
            try {
                listener();
            } catch (error) {
                logger.warn('通知 consumer 注册表监听器失败。', safeFailureLogDetail(error, {
                    reasonCode: 'INTERNAL_ERROR',
                    stage: 'llm.registry.listener',
                }));
            }
        });
    }

    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    dispose(): void {
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = null;
        this.persistCallback = null;
        this.listeners.clear();
    }

    private schedulePersist(): void {
        if (this.persistTimer) return;
        this.persistTimer = setTimeout(async () => {
            this.persistTimer = null;
            if (this.persistCallback) {
                try {
                    await this.persistCallback(this.exportPersistentSnapshots());
                } catch (e) {
                    logger.error('持久化消费方注册快照失败:', safeFailureLogDetail(e, { reasonCode: 'INTERNAL_ERROR', stage: 'llm.registry.persist' }));
                }
            }
        }, 500);
    }
}
