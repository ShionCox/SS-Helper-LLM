/**
 * 消费方注册中心
 * 职责：
 * - 幂等 upsert 注册（支持先启动后挂载、热更新、禁用再启用、重复覆盖）
 * - 持久字段与会话字段分离
 * - 失效绑定检测（任务删除 / 类型变更 / 能力不匹配 / 长时间未注册）
 * - 只读查询 API
 *
 * 注册接口是同步命令式；内部持久化、广播、异步落盘由注册中心自己排程处理。
 */

import { logger } from '../runtime/logger';
import type {
    ConsumerRegistration,
    ConsumerPersistentSnapshot,
    ConsumerSessionSnapshot,
    ConsumerSnapshot,
    StaleBindingSnapshot,
    TaskDescriptor,
    RouteBinding,
    LLMCapability,
    CapabilityKind,
} from '../schema/types';


/** 失效触发：插件长时间未注册（默认 7 天） */
const PLUGIN_INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

type ConsumerRegistryListener = () => void;

export class ConsumerRegistry {
    /** 持久快照 */
    private persistent: Map<string, ConsumerPersistentSnapshot> = new Map();
    /** 会话快照 */
    private sessions: Map<string, ConsumerSessionSnapshot> = new Map();
    /** 失效绑定缓存 */
    private staleBindings: Map<string, StaleBindingSnapshot[]> = new Map();

    /** 外部注入的持久化回调（由 LLMHub 主类设置） */
    private persistCallback: ((snapshots: Record<string, ConsumerPersistentSnapshot>) => void) | null = null;
    /** 外部注入的资源能力查询回调 */
    private resourceCapabilityQuery: ((resourceId: string) => LLMCapability[]) | null = null;
    /** 只读变更监听器 */
    private listeners: Set<ConsumerRegistryListener> = new Set();

    // ─── 初始化与恢复 ───

    /** 从持久存储恢复（仅恢复持久字段，不恢复会话态） */
    restoreFromStorage(snapshots: Record<string, ConsumerPersistentSnapshot>): void {
        for (const [pluginId, snapshot] of Object.entries(snapshots)) {
            this.persistent.set(pluginId, { ...snapshot });
            // 会话字段初始化为离线
            this.sessions.set(pluginId, this.createOfflineSession());
        }
        logger.info(`从持久存储恢复了 ${this.persistent.size} 个消费方注册。`);
        this.notifyListeners();
    }

    /** 设置持久化回调 */
    setPersistCallback(cb: (snapshots: Record<string, ConsumerPersistentSnapshot>) => void): void {
        this.persistCallback = cb;
    }

    /** 设置资源能力查询回调 */
    setResourceCapabilityQuery(cb: (resourceId: string) => LLMCapability[]): void {
        this.resourceCapabilityQuery = cb;
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
        const { pluginId, displayName, registrationVersion, tasks, routeBindings } = registration;

        const existing = this.persistent.get(pluginId);
        const staleEntries: StaleBindingSnapshot[] = [];

        if (existing) {
            // 检测失效：与旧版本对比
            staleEntries.push(
                ...this.detectStaleOnUpdate(existing, registration)
            );
        }

        const snapshot: ConsumerPersistentSnapshot = {
            pluginId,
            displayName,
            registrationVersion,
            tasks: [...tasks],
            routeBindings: routeBindings ? [...routeBindings] : [],
            staleReason: undefined,
            userOverrides: existing?.userOverrides,
            recommendedSnapshots: this.buildRecommendedSnapshots(tasks),
        };

        this.persistent.set(pluginId, snapshot);

        // 更新会话为在线
        this.sessions.set(pluginId, {
            online: true,
            seenAt: Date.now(),
            currentQueueState: { pendingCount: 0 },
            currentOverlayState: {},
        });

        // 更新失效绑定
        if (staleEntries.length > 0) {
            const existingStale = this.staleBindings.get(pluginId) || [];
            this.staleBindings.set(pluginId, [...existingStale, ...staleEntries]);
            logger.warn(`插件 ${pluginId} 注册更新，检测到 ${staleEntries.length} 个失效绑定。`);
        }

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
        if (!opts?.keepPersistent) {
            this.persistent.delete(pluginId);
            this.staleBindings.delete(pluginId);
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

    /** 查询某个插件的失效绑定 */
    getStaleBindings(pluginId: string): StaleBindingSnapshot[] {
        return this.staleBindings.get(pluginId) || [];
    }

    /** 查询所有失效绑定 */
    listAllStaleBindings(): Map<string, StaleBindingSnapshot[]> {
        return new Map(this.staleBindings);
    }

    /** 获取某插件某任务的描述 */
    getTaskDescriptor(pluginId: string, taskKey: string): TaskDescriptor | undefined {
        return this.persistent.get(pluginId)?.tasks.find(t => t.taskKey === taskKey);
    }

    /** 获取某插件的路由绑定 */
    getRouteBindings(pluginId: string): RouteBinding[] {
        return this.persistent.get(pluginId)?.routeBindings || [];
    }

    /** 检查插件是否在线 */
    isOnline(pluginId: string): boolean {
        return this.sessions.get(pluginId)?.online === true;
    }

    /** 标记心跳 */
    markSeen(pluginId: string): void {
        const session = this.sessions.get(pluginId);
        if (session) {
            session.seenAt = Date.now();
            session.online = true;
        }
    }

    /** 更新队列状态 */
    updateQueueState(pluginId: string, state: ConsumerSessionSnapshot['currentQueueState']): void {
        const session = this.sessions.get(pluginId);
        if (session) {
            session.currentQueueState = state;
        }
    }

    /** 更新展示状态 */
    updateOverlayState(pluginId: string, state: ConsumerSessionSnapshot['currentOverlayState']): void {
        const session = this.sessions.get(pluginId);
        if (session) {
            session.currentOverlayState = state;
        }
    }

    // ─── 失效检测 ───

    /** 全局失效扫描（可定期调用） */
    scanForStalePlugins(): void {
        const now = Date.now();
        for (const [pluginId, session] of this.sessions) {
            if (!session.online && (now - session.seenAt) > PLUGIN_INACTIVE_THRESHOLD_MS) {
                const persistent = this.persistent.get(pluginId);
                if (persistent && !persistent.staleReason) {
                    persistent.staleReason = 'plugin_inactive';
                    const staleEntries: StaleBindingSnapshot[] = persistent.tasks.map(task => ({
                        taskKey: task.taskKey,
                        taskKind: task.taskKind,
                        registrationVersion: persistent.registrationVersion,
                        lastSeenAt: session.seenAt,
                        source: 'plugin_inactive' as const,
                        isStale: true as const,
                        staleReason: `插件 ${pluginId} 已超过 ${Math.floor(PLUGIN_INACTIVE_THRESHOLD_MS / 86400000)} 天未注册`,
                    }));
                    this.staleBindings.set(pluginId, staleEntries);
                }
            }
        }
    }

    /** 清除某个插件的失效标记（例如用户确认后） */
    clearStaleBindings(pluginId: string): void {
        this.staleBindings.delete(pluginId);
        const persistent = this.persistent.get(pluginId);
        if (persistent) {
            persistent.staleReason = undefined;
        }
        this.notifyListeners();
        this.schedulePersist();
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
            currentQueueState: { pendingCount: 0 },
            currentOverlayState: {},
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
                logger.warn('通知 consumer 注册表监听器失败。', error);
            }
        });
    }

    /** 新旧版本对比检测失效绑定 */
    private detectStaleOnUpdate(
        existing: ConsumerPersistentSnapshot,
        incoming: ConsumerRegistration,
    ): StaleBindingSnapshot[] {
        const stale: StaleBindingSnapshot[] = [];
        const incomingTaskIds = new Set(incoming.tasks.map(t => t.taskKey));
        const incomingTaskMap = new Map(incoming.tasks.map(t => [t.taskKey, t]));

        for (const oldTask of existing.tasks) {
            // 任务被删除
            if (!incomingTaskIds.has(oldTask.taskKey)) {
                stale.push({
                    taskKey: oldTask.taskKey,
                    taskKind: oldTask.taskKind,
                    registrationVersion: existing.registrationVersion,
                    lastSeenAt: Date.now(),
                    source: 'task_removed',
                    isStale: true,
                    staleReason: `任务 ${oldTask.taskKey} 在新版本 (v${incoming.registrationVersion}) 中被移除`,
                });
                continue;
            }

            const newTask = incomingTaskMap.get(oldTask.taskKey)!;

            // 任务类型变更
            if (oldTask.taskKind !== newTask.taskKind) {
                stale.push({
                    taskKey: oldTask.taskKey,
                    taskKind: oldTask.taskKind,
                    registrationVersion: existing.registrationVersion,
                    lastSeenAt: Date.now(),
                    source: 'task_kind_changed',
                    isStale: true,
                    staleReason: `任务 ${oldTask.taskKey} 类型从 ${oldTask.taskKind} 变更为 ${newTask.taskKind}`,
                });
                continue;
            }

            // 能力要求变更 → 检查旧资源是否还合法
            if (this.capabilitiesChanged(oldTask.requiredCapabilities, newTask.requiredCapabilities)) {
                const binding = existing.routeBindings?.find(b => b.taskKey === oldTask.taskKey);
                if (binding && this.resourceCapabilityQuery) {
                    const resourceCaps = this.resourceCapabilityQuery(binding.resourceId);
                    const missing = newTask.requiredCapabilities.filter(c => !resourceCaps.includes(c));
                    if (missing.length > 0) {
                        stale.push({
                            taskKey: oldTask.taskKey,
                            taskKind: oldTask.taskKind,
                            registrationVersion: existing.registrationVersion,
                            lastSeenAt: Date.now(),
                            source: 'capability_mismatch',
                            isStale: true,
                            staleReason: `资源 ${binding.resourceId} 不满足新增能力要求: ${missing.join(', ')}`,
                        });
                    }
                }
            }
        }

        return stale;
    }

    private capabilitiesChanged(oldCaps: LLMCapability[], newCaps: LLMCapability[]): boolean {
        if (oldCaps.length !== newCaps.length) return true;
        const sorted1 = [...oldCaps].sort();
        const sorted2 = [...newCaps].sort();
        return sorted1.some((c, i) => c !== sorted2[i]);
    }

    private buildRecommendedSnapshots(
        tasks: TaskDescriptor[],
    ): Record<string, { taskKey: string; resourceId?: string; model?: string; profileId?: string }> {
        const result: Record<string, { taskKey: string; resourceId?: string; model?: string; profileId?: string }> = {};
        for (const task of tasks) {
            if (task.recommendedRoute) {
                result[task.taskKey] = {
                    taskKey: task.taskKey,
                    resourceId: task.recommendedRoute.resourceId,
                    profileId: task.recommendedRoute.profileId,
                };
            }
        }
        return result;
    }

    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    private schedulePersist(): void {
        if (this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            if (this.persistCallback) {
                try {
                    this.persistCallback(this.exportPersistentSnapshots());
                } catch (e) {
                    logger.error('持久化消费方注册快照失败:', e);
                }
            }
        }, 500);
    }
}
