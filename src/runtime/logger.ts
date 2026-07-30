import {
    readSSHelperFailure,
    startSSHelperPerformanceSpan,
    traceSSHelperPerformance,
    type SSHelperFailureContext,
} from '@ss-helper/sdk';

export interface LlmLogger {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
    success(message: string, detail?: unknown): void;
}

export function safeFailureLogDetail(
    error: unknown,
    fallback: Pick<SSHelperFailureContext, 'reasonCode' | 'stage'>
        & Partial<Omit<SSHelperFailureContext, 'reasonCode' | 'stage'>>,
): SSHelperFailureContext {
    return readSSHelperFailure(error, fallback)!;
}

function emit(method: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
    if (detail === undefined) {
        console[method](`[SS-Helper LLM] ${message}`);
        return;
    }
    console[method](`[SS-Helper LLM] ${message}`, detail);
}

export const logger: LlmLogger = {
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
    success: (message, detail) => emit('info', message, detail),
};

export function traceLlmStartup(stage: string): void {
    const entry = traceSSHelperPerformance('llm', stage);
    const enabled = (globalThis as typeof globalThis & { __SSHelperLlmStartupTrace?: unknown }).__SSHelperLlmStartupTrace === true;
    if (enabled) logger.info(`启动检查点：${stage}${entry ? `（+${entry.deltaMs.toFixed(1)}ms / ${entry.elapsedMs.toFixed(1)}ms）` : ''}`);
}

export const startLlmPerformanceSpan = (stage: string) => startSSHelperPerformanceSpan('llm', stage);
