import {
    describeSSHelperFailure,
    isSSHelperReasonCode,
    type PlainData,
} from '@ss-helper/sdk';

export type LogRow = Record<string, unknown>;

export interface LogPresentation {
    readonly taskKind: string;
    readonly taskLabel: string;
    readonly taskKey: string;
    readonly state: string;
    readonly source: string;
    readonly model: string;
    readonly latencyMs?: number;
    readonly createdAt: unknown;
    readonly attempt: string;
}

export const STATUS_LABEL: Record<string, string> = { completed: '已完成', failed: '失败', queued: '排队中', running: '运行中', cancelled: '已取消' };
const TASK_LABEL: Record<string, string> = { generation: '生成', embedding: '向量化', rerank: '重排序' };
const ATTEMPT_PHASE_LABEL: Record<string, string> = {
    initial: '首次请求',
    schema_repair: 'Schema 修复',
    transient_retry: '瞬态重试',
    route_fallback: '备用路由',
    transport_fallback: '传输降级',
};

export function asRecord(value: PlainData | unknown): LogRow {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as LogRow : {};
}

export function text(value: unknown, fallback = '—'): string {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
}

function finiteNumber(value: unknown): number | undefined {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized >= 0 ? normalized : undefined;
}

export function clampLogListWidth(layoutWidth: number, requestedWidth: number, minListWidth = 240, minDetailWidth = 420, splitterWidth = 12): number {
    const safeLayoutWidth = Math.max(0, layoutWidth);
    const maxListWidth = Math.max(minListWidth, safeLayoutWidth - minDetailWidth - splitterWidth);
    return Math.min(maxListWidth, Math.max(minListWidth, requestedWidth));
}

export function presentLogRow(row: LogRow): LogPresentation {
    const request = asRecord(row.request);
    const response = asRecord(row.response);
    const meta = asRecord(response.meta);
    const taskKey = text(row.taskKey ?? request.taskKey ?? request.task ?? request.taskKind, '未标记任务');
    const rawKind = text(row.taskKind ?? meta.capabilityKind ?? request.capabilityKind ?? request.kind, '').toLowerCase();
    const taskKind = rawKind in TASK_LABEL
        ? rawKind
        : taskKey.toLowerCase().includes('rerank')
            ? 'rerank'
            : taskKey.toLowerCase().includes('embed')
                ? 'embedding'
                : 'generation';
    const attemptIndex = text(row.attemptIndex, '');
    const attemptTag = ATTEMPT_PHASE_LABEL[text(row.attemptPhase, '')] ?? text(row.attemptTag, '');
    return {
        taskKind,
        taskLabel: TASK_LABEL[taskKind] ?? taskKind,
        taskKey,
        state: text(row.state, 'completed'),
        source: text(row.provider ?? row.resourceId ?? meta.resourceId, '来源未知'),
        model: text(row.model ?? meta.model, ''),
        latencyMs: finiteNumber(row.latencyMs ?? meta.latencyMs),
        createdAt: row.createdAt ?? row.finishedAt ?? meta.finishedAt ?? row.queuedAt ?? meta.queuedAt,
        attempt: [attemptIndex, attemptTag].filter(Boolean).join(' · ') || '未记录',
    };
}

export function presentDiagnostic(failure: unknown): { readonly code?: string; readonly message?: string } {
    const code = text(asRecord(failure).reasonCode, '').trim();
    if (!isSSHelperReasonCode(code)) return {};
    const diagnostic = describeSSHelperFailure(failure);
    return {
        code: diagnostic.reasonCode,
        message: `${diagnostic.title}：${diagnostic.reason} ${diagnostic.action}`,
    };
}
