export function providerHttpError(provider: string, status: number): Error & { code: string } {
    return Object.assign(new Error(`${provider} Provider 请求失败（HTTP ${status}）`), { code: 'LLM_PROVIDER_HTTP_ERROR' });
}

export function providerProtocolError(provider: string): Error & { code: string } {
    return Object.assign(new Error(`${provider} Provider 返回格式无效`), { code: 'LLM_PROVIDER_PROTOCOL_ERROR' });
}
