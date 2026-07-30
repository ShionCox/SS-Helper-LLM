import {
    createSSHelperError,
    describeSSHelperFailure,
    readSSHelperFailure,
    type SSHelperFailureContext,
    type SSHelperReasonCode,
} from '@ss-helper/sdk';
import type { ProviderConnectionResult, ProviderModelListResult } from './types';

interface SafeProviderHttpClassification {
    readonly code?: string;
    readonly type?: string;
    readonly param?: string;
}

const SAFE_PROVIDER_TOKEN = /^[a-z0-9_.:/\-\[\]]{1,128}$/iu;
const MODEL_ERROR_CODES = new Set([
    'model_not_found', 'model_not_exist', 'unknown_model', 'invalid_model',
]);
const RESPONSE_FORMAT_ERROR_CODES = new Set([
    'unsupported_response_format', 'response_format_unsupported', 'json_schema_unsupported',
    'unsupported_json_schema', 'response_format_not_supported',
]);
const CONTENT_FILTER_CODES = new Set(['content_filter', 'content_filtered', 'safety_blocked']);
const TOKEN_LIMIT_CODES = new Set(['context_length_exceeded', 'max_tokens_exceeded', 'token_limit_exceeded']);

function plainRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function safeProviderToken(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return SAFE_PROVIDER_TOKEN.test(normalized) ? normalized : undefined;
}

function safeClassification(unsafeDetail: unknown): SafeProviderHttpClassification {
    let parsed = unsafeDetail;
    if (typeof unsafeDetail === 'string') {
        if (unsafeDetail.length > 65_536) return {};
        try { parsed = JSON.parse(unsafeDetail); } catch { return {}; }
    }
    const root = plainRecord(parsed);
    const error = plainRecord(root?.error) ?? root;
    if (error === undefined) return {};
    const code = safeProviderToken(error.code ?? root?.code);
    const type = safeProviderToken(error.type ?? error.status ?? root?.type ?? root?.status);
    const param = safeProviderToken(error.param ?? root?.param);
    return {
        ...(code ? { code } : {}),
        ...(type ? { type } : {}),
        ...(param ? { param } : {}),
    };
}

function reasonForHttpStatus(status: number, classification: SafeProviderHttpClassification): SSHelperReasonCode {
    if (status === 401 || status === 403) return 'AUTH_FAILED';
    if (status === 408 || status === 504) return 'HTTP_REQUEST_TIMEOUT';
    if (status === 429) return 'RATE_LIMITED';
    const code = classification.code?.toLowerCase();
    const type = classification.type?.toLowerCase();
    const param = classification.param?.toLowerCase();
    if ((code !== undefined && MODEL_ERROR_CODES.has(code))
        || (type !== undefined && MODEL_ERROR_CODES.has(type))
        || (status === 404 && (param === 'model' || param === 'model_id'))) return 'MODEL_NOT_FOUND';
    if ((code !== undefined && RESPONSE_FORMAT_ERROR_CODES.has(code))
        || (type !== undefined && RESPONSE_FORMAT_ERROR_CODES.has(type))
        || param === 'response_format'
        || param?.startsWith('response_format.') === true) return 'RESPONSE_FORMAT_UNSUPPORTED';
    if ((code !== undefined && CONTENT_FILTER_CODES.has(code)) || (type !== undefined && CONTENT_FILTER_CODES.has(type))) return 'CONTENT_FILTERED';
    if ((code !== undefined && TOKEN_LIMIT_CODES.has(code)) || (type !== undefined && TOKEN_LIMIT_CODES.has(type))) return 'TOKEN_LIMIT_EXCEEDED';
    if (status === 404) return 'ENDPOINT_NOT_FOUND';
    if (status >= 500) return 'PROVIDER_UNAVAILABLE';
    return 'PROVIDER_HTTP_ERROR';
}

export function providerHttpError(providerKind: string, status: number, unsafeDetail?: unknown): Error {
    const classification = safeClassification(unsafeDetail);
    return createSSHelperError(reasonForHttpStatus(status, classification), {
        stage: 'llm.provider.http',
        httpStatus: status,
        providerKind,
        ...(classification.code ? { providerErrorCode: classification.code } : {}),
        ...(classification.type ? { providerErrorType: classification.type } : {}),
        ...(classification.param ? { providerErrorParam: classification.param } : {}),
    });
}

export async function providerHttpErrorFromResponse(providerKind: string, response: Response): Promise<Error> {
    return providerHttpError(providerKind, response.status, await response.text().catch(() => undefined));
}

export function providerProtocolError(providerKind: string): Error {
    return createSSHelperError('PROVIDER_RESPONSE_INVALID', {
        stage: 'llm.provider.response',
        providerKind,
    });
}

export function providerConnectionFailure(
    error: unknown,
    context: Pick<SSHelperFailureContext, 'stage'> & Partial<Omit<SSHelperFailureContext, 'reasonCode' | 'stage'>>,
    latencyMs?: number,
): ProviderConnectionResult {
    const failure = readSSHelperFailure(error, {
        reasonCode: isAbortError(error) ? 'REQUEST_ABORTED' : 'INTERNAL_ERROR',
        ...context,
    })!;
    const diagnostic = describeSSHelperFailure(failure);
    return {
        ok: false,
        message: diagnostic.reason,
        failure,
        ...(latencyMs === undefined ? {} : { latencyMs }),
    };
}

export function providerModelListFailure(
    error: unknown,
    context: Pick<SSHelperFailureContext, 'stage'> & Partial<Omit<SSHelperFailureContext, 'reasonCode' | 'stage'>>,
): ProviderModelListResult {
    const failure = readSSHelperFailure(error, {
        reasonCode: isAbortError(error) ? 'REQUEST_ABORTED' : 'INTERNAL_ERROR',
        ...context,
    })!;
    const diagnostic = describeSSHelperFailure(failure);
    return { ok: false, models: [], message: diagnostic.reason, failure };
}

function isAbortError(error: unknown): boolean {
    return plainRecord(error)?.name === 'AbortError';
}
