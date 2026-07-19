export interface ProviderHttpError extends Error {
    readonly code: 'LLM_PROVIDER_HTTP_ERROR';
    readonly status: number;
    readonly detail?: string;
}

export function providerHttpError(provider: string, status: number, detail?: string): ProviderHttpError {
    return Object.assign(new Error(`${provider} Provider 请求失败（HTTP ${status}）`), { code: 'LLM_PROVIDER_HTTP_ERROR' as const, status, ...(detail ? { detail } : {}) });
}

export function providerProtocolError(provider: string): Error & { code: string } {
    return Object.assign(new Error(`${provider} Provider 返回格式无效`), { code: 'LLM_PROVIDER_PROTOCOL_ERROR' });
}

export function isResponseFormatUnsupported(error: unknown): boolean {
    const typed = error as Partial<ProviderHttpError> | undefined;
    if (typed?.code !== 'LLM_PROVIDER_HTTP_ERROR' || ![400, 404, 415, 422].includes(Number(typed.status))) return false;
    const detail = `${typed.message || ''}\n${typed.detail || ''}`.toLowerCase();
    return /response[_ -]?format|json[_ -]?schema|structured[_ -]?output|unsupported.*format|format.*unsupported/u.test(detail);
}
