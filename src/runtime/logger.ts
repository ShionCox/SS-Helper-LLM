export interface LlmLogger {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
    success(message: string, detail?: unknown): void;
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
