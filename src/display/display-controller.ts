/**
 * 展示控制器
 * 职责：
 * - 管理 LLMOverlaySpec 的生命周期
 * - 强制结构化展示（Level 1）与受限富内容（Level 2）
 * - 展示模式：fullscreen / compact / silent
 * - silent 权限约束
 * - compact 模式自动关闭
 * - updateOverlay / closeOverlay 同步命令式接口（内部异步）
 */

import { logger } from '../runtime/logger';
import type {
    LLMOverlaySpec,
    LLMSafeRichContent,
    OverlayPatch,
    DisplayMode,
    RequestRecord,
    LLMRunResult,
    SilentPermissionGrant,
} from '../schema/types';


/** 允许的 HTML 白名单标签 */
const ALLOWED_TAGS = new Set([
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'code', 'pre',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'span', 'div', 'blockquote', 'a', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'hr', 'mark', 'small', 'sub', 'sup',
]);

/** 平台内部插件 ID（默认具备 silent 权限） */
const PLATFORM_INTERNAL_PLUGINS = new Set(['stx_llmhub', 'ss-helper.memory']);
const MEMORY_OS_AUTO_CLOSE_TASKS = new Set(['memory_cold_start_core', 'memory_cold_start_state']);
const COMPACT_AUTO_CLOSE_MS: number = 3000;

function formatTaskTitle(record: RequestRecord): string {
    const taskLabel = String(record.taskDescription || record.taskKey || '').trim() || record.taskKey;
    if (record.consumer === 'ss-helper.memory') {
        return taskLabel;
    }
    return `${record.consumer} / ${taskLabel}`;
}

export class DisplayController {
    /** 当前活跃的覆层 */
    private activeOverlays: Map<string, LLMOverlaySpec> = new Map();
    /** silent 权限授权表 */
    private silentPermissions: Map<string, SilentPermissionGrant> = new Map(); // key: `${pluginId}::${taskKey}`
    /** 自动关闭计时器 */
    private autoCloseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /** 外部注入的 overlay 渲染回调 */
    private renderCallback: ((spec: LLMOverlaySpec) => void) | null = null;
    /** 外部注入的 overlay 关闭回调 */
    private closeCallback: ((requestId: string, reason?: string) => void) | null = null;
    /** 外部注入的通知编排器 overlay 已关闭的回调 */
    private notifyOrchestratorClosed: ((requestId: string) => void) | null = null;

    // ─── 初始化 ───

    setRenderCallback(cb: (spec: LLMOverlaySpec) => void): void {
        this.renderCallback = cb;
    }

    setCloseCallback(cb: (requestId: string, reason?: string) => void): void {
        this.closeCallback = cb;
    }

    setNotifyOrchestratorClosed(cb: (requestId: string) => void): void {
        this.notifyOrchestratorClosed = cb;
    }

    /** 从持久存储恢复 silent 权限 */
    restoreSilentPermissions(permissions: SilentPermissionGrant[]): void {
        this.silentPermissions.clear();
        for (const p of permissions) {
            this.silentPermissions.set(`${p.pluginId}::${p.taskKey}`, p);
        }
    }

    // ─── 权限管理 ───

    /** 检查某个插件任务是否有 silent 权限 */
    canUseSilent(pluginId: string, taskKey: string, backgroundEligible?: boolean): boolean {
        // 平台内部插件始终允许
        if (PLATFORM_INTERNAL_PLUGINS.has(pluginId)) return true;
        // 注册项声明 backgroundEligible
        if (backgroundEligible) return true;
        // 用户在设置页显式授权
        return this.silentPermissions.has(`${pluginId}::${taskKey}`);
    }

    /** 授权 silent 权限 */
    grantSilentPermission(pluginId: string, taskKey: string): void {
        this.silentPermissions.set(`${pluginId}::${taskKey}`, {
            pluginId,
            taskKey,
            grantedAt: Date.now(),
        });
    }

    /** 撤销 silent 权限 */
    revokeSilentPermission(pluginId: string, taskKey: string): void {
        this.silentPermissions.delete(`${pluginId}::${taskKey}`);
    }

    /** 导出 silent 权限列表 */
    exportSilentPermissions(): SilentPermissionGrant[] {
        return Array.from(this.silentPermissions.values());
    }

    // ─── 展示模式验证与降级 ───

    /**
     * 验证并可能降级展示模式
     */
    validateDisplayMode(
        mode: DisplayMode,
        pluginId: string,
        taskKey: string,
        backgroundEligible?: boolean,
        blockNext?: boolean,
    ): DisplayMode {
        // silent 权限检查
        if (mode === 'silent') {
            if (!this.canUseSilent(pluginId, taskKey, backgroundEligible)) {
                logger.warn(`插件 ${pluginId} 任务 ${taskKey} 无 silent 权限，已降级为紧凑弹窗`);
                return 'compact';
            }
            return 'silent';
        }

        // fullscreen + blockNext=false：右下角紧凑弹窗已禁用，直接静默
        if (mode === 'fullscreen' && blockNext === false) {
            return 'silent';
        }

        return mode;
    }

    // ─── 展示生命周期（同步命令式） ───

    /**
     * 为正在执行中的请求创建占位覆层。
     */
    openPendingOverlay(record: RequestRecord): void {
        const displayMode = record.enqueueOptions.displayMode || 'fullscreen';
        if (displayMode === 'silent') {
            return;
        }

        const existing = this.activeOverlays.get(record.requestId);
        const spec: LLMOverlaySpec = existing || {
            requestId: record.requestId,
            title: formatTaskTitle(record),
            status: 'loading',
            content: {
                type: 'text',
                body: [
                    '正在调用模型处理中…',
                    '',
                    `任务：${String(record.taskDescription || record.taskKey || '').trim() || record.taskKey}`,
                    `请求：${record.requestId}`,
                ].join('\n'),
            },
            displayMode,
            autoClose: false,
        };

        spec.title = formatTaskTitle(record);
        spec.status = 'loading';
        spec.displayMode = displayMode;
        spec.autoClose = false;
        spec.autoCloseMs = undefined;
        spec.autoCloseAt = undefined;
        spec.content = {
            type: 'text',
            body: [
                '正在调用模型处理中…',
                '',
                `任务：${String(record.taskDescription || record.taskKey || '').trim() || record.taskKey}`,
                `请求：${record.requestId}`,
            ].join('\n'),
        };

        this.activeOverlays.set(record.requestId, spec);
        this.renderCallback?.(spec);
    }

    /**
     * 为请求创建展示覆层（由编排器调用）
     */
    createOverlay(record: RequestRecord, result: LLMRunResult<any>): void {
        const displayMode = record.enqueueOptions.displayMode || 'fullscreen';

        if (displayMode === 'silent') {
            // silent 不创建覆层，直接通知关闭
            this.notifyOrchestratorClosed?.(record.requestId);
            return;
        }

        const spec: LLMOverlaySpec = this.activeOverlays.get(record.requestId) || {
            requestId: record.requestId,
            title: formatTaskTitle(record),
            status: result.ok ? 'done' : 'error',
            content: this.buildSafeContent(result),
            displayMode,
            autoClose: false,
            autoCloseMs: undefined,
        };

        spec.title = formatTaskTitle(record);
        spec.status = result.ok ? 'done' : 'error';
        spec.content = this.buildSafeContent(result);
        spec.displayMode = displayMode;
        spec.autoClose = displayMode === 'compact'
            ? true
            : Boolean(result.ok && record.consumer === 'ss-helper.memory' && MEMORY_OS_AUTO_CLOSE_TASKS.has(record.taskKey));
        spec.autoCloseMs = displayMode === 'compact'
            ? Math.max(0, Math.trunc(Number(record.enqueueOptions.autoCloseMs) || COMPACT_AUTO_CLOSE_MS))
            : (spec.autoClose ? 300 : undefined);
        spec.autoCloseAt = spec.autoClose && typeof spec.autoCloseMs === 'number' && spec.autoCloseMs > 0
            ? Date.now() + spec.autoCloseMs
            : undefined;

        this.activeOverlays.set(record.requestId, spec);

        // 渲染
        if (this.renderCallback) {
            this.renderCallback(spec);
        }

        const existingTimer = this.autoCloseTimers.get(record.requestId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.autoCloseTimers.delete(record.requestId);
        }
        if (spec.autoClose && typeof spec.autoCloseMs === 'number' && spec.autoCloseMs > 0) {
            const timer = setTimeout((): void => {
                this.closeOverlay(record.requestId, 'auto_close');
            }, spec.autoCloseMs);
            this.autoCloseTimers.set(record.requestId, timer);
        }
    }

    /**
     * 更新覆层（同步命令式接口）
     */
    updateOverlay(requestId: string, patch: OverlayPatch): void {
        const spec = this.activeOverlays.get(requestId);
        if (!spec) {
            logger.warn(`updateOverlay: 覆层 ${requestId} 不存在`);
            return;
        }

        // 应用补丁
        if (patch.title !== undefined) spec.title = patch.title;
        if (patch.status !== undefined) spec.status = patch.status;
        if (patch.progress !== undefined) spec.progress = patch.progress;
        if (patch.content !== undefined) spec.content = this.sanitizeContent(patch.content);
        if (patch.actions !== undefined) spec.actions = patch.actions;

        // 重新渲染
        if (this.renderCallback) {
            this.renderCallback(spec);
        }
    }

    /**
     * 关闭覆层（同步命令式接口）
     */
    closeOverlay(requestId: string, reason?: string): void {
        const spec = this.activeOverlays.get(requestId);
        if (!spec) return;

        // 清理自动关闭计时器
        const timer = this.autoCloseTimers.get(requestId);
        if (timer) {
            clearTimeout(timer);
            this.autoCloseTimers.delete(requestId);
        }

        this.activeOverlays.delete(requestId);

        // 通知 UI 关闭
        if (this.closeCallback) {
            this.closeCallback(requestId, reason);
        }

        // 通知编排器
        if (this.notifyOrchestratorClosed) {
            this.notifyOrchestratorClosed(requestId);
        }

        logger.info(`覆层 ${requestId} 已关闭: ${reason || 'user_close'}`);
    }

    // ─── 查询 ───

    getActiveOverlay(requestId: string): LLMOverlaySpec | undefined {
        return this.activeOverlays.get(requestId);
    }

    listActiveOverlays(): LLMOverlaySpec[] {
        return Array.from(this.activeOverlays.values());
    }

    // ─── 内容安全 ───

    private buildSafeContent(result: LLMRunResult<any>): LLMSafeRichContent {
        if (!result.ok) {
            return { type: 'text', body: `错误: ${result.error}` };
        }
        const data = result.data;
        if (typeof data === 'string') {
            return { type: 'text', body: data };
        }
        return { type: 'text', body: JSON.stringify(data, null, 2) };
    }

    private sanitizeContent(content: LLMSafeRichContent): LLMSafeRichContent {
        if (content.type === 'html') {
            return { ...content, body: this.sanitizeHtml(content.body) };
        }
        return content;
    }

    /** 简易 HTML 白名单清洗 */
    private sanitizeHtml(html: string): string {
        // 移除 script/style 标签及内容
        let clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
        clean = clean.replace(/<style[\s\S]*?<\/style>/gi, '');
        // 移除事件处理器属性
        clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
        clean = clean.replace(/\s+on\w+\s*=\s*\S+/gi, '');
        // 移除 javascript: 协议
        clean = clean.replace(/javascript\s*:/gi, '');
        return clean;
    }
}
