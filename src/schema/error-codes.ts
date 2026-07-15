/**
 * LLM Hub 错误码枚举
 * 标准化所有插件的错误返回格式
 */

export enum ReasonCode {
    /** 请求超时 */
    TIMEOUT = 'timeout',
    /** 返回非法 JSON */
    INVALID_JSON = 'invalid_json',
    /** Schema 校验失败 */
    SCHEMA_VALIDATION_FAILED = 'schema_validation_failed',
    /** 被限流 */
    RATE_LIMITED = 'rate_limited',
    /** 认证失败（API Key 无效） */
    AUTH_FAILED = 'auth_failed',
    /** Provider 不可用 */
    PROVIDER_UNAVAILABLE = 'provider_unavailable',
    /** 熔断器激活 */
    CIRCUIT_OPEN = 'circuit_open',
    /** 未知错误 */
    UNKNOWN = 'unknown',
    /** 网络错误 */
    NETWORK_ERROR = 'network_error',
    /** 内容过滤 */
    CONTENT_FILTERED = 'content_filtered',
    /** Token 超出限制 */
    TOKEN_LIMIT_EXCEEDED = 'token_limit_exceeded',
}

/**
 * 标准化的错误响应
 */
export interface LLMError {
    reasonCode: ReasonCode;
    message: string;
    retryable: boolean;
    fallbackUsed: boolean;
    provider?: string;
    latencyMs?: number;
}

/**
 * 根据原始错误信息推断 ReasonCode
 */
export function inferReasonCode(errorMsg: string, statusCode?: number): ReasonCode {
    const msg = errorMsg.toLowerCase();

    if (msg.includes('timeout') || msg.includes('超时')) return ReasonCode.TIMEOUT;
    if (msg.includes('json') || msg.includes('parse')) return ReasonCode.INVALID_JSON;
    if (msg.includes('schema') || msg.includes('校验')) return ReasonCode.SCHEMA_VALIDATION_FAILED;
    if (msg.includes('rate') || msg.includes('429') || statusCode === 429) return ReasonCode.RATE_LIMITED;
    if (msg.includes('auth') || msg.includes('401') || msg.includes('key') || statusCode === 401) return ReasonCode.AUTH_FAILED;
    if (msg.includes('circuit') || msg.includes('熔断')) return ReasonCode.CIRCUIT_OPEN;
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused')) return ReasonCode.NETWORK_ERROR;
    if (msg.includes('content_filter') || msg.includes('过滤')) return ReasonCode.CONTENT_FILTERED;
    if (msg.includes('token') || msg.includes('length')) return ReasonCode.TOKEN_LIMIT_EXCEEDED;

    return ReasonCode.UNKNOWN;
}
