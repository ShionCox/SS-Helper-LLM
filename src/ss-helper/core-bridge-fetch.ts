import type {
  PlainData,
  PluginApiRequest,
  PluginApiResponse,
  PluginRequestOptions,
} from '@ss-helper/sdk';
import {
  createSSHelperError,
  isSSHelperReasonCode,
} from '@ss-helper/sdk';

const BRIDGE_PATH = '/api/plugins/ss-helper-sdk/internal/bridge/v0/call' as const;

export type CoreBridgeRequest = (
  request: PluginApiRequest,
  options?: PluginRequestOptions,
) => Promise<PluginApiResponse>;

function plainHeaders(value: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  new Headers(value).forEach((headerValue, headerName) => {
    output[headerName] = headerValue;
  });
  return output;
}

function bridgeRecord(value: PlainData | undefined): Readonly<Record<string, PlainData>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, PlainData>>
    : undefined;
}

export function createCoreBridgeFetch(request: CoreBridgeRequest): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `http_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const source = input instanceof Request ? input : undefined;
    const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    const method = String(init.method ?? source?.method ?? 'GET').toUpperCase();
    const body = init.body ?? (source === undefined ? undefined : await source.text());
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw createSSHelperError('HTTP_BODY_INVALID', {
        stage: 'llm.bridge.http.request',
        requestId,
      });
    }
    const signal = init.signal ?? source?.signal;
    const response = await request({
      path: BRIDGE_PATH,
      method: 'POST',
      body: {
        version: 0,
        pluginId: 'ss-helper.llm',
        operation: 'http.request',
        requestId,
        input: {
          url,
          method,
          headers: plainHeaders(init.headers ?? source?.headers),
          ...(body === undefined || body === null ? {} : { body }),
        },
      },
    }, signal === undefined || signal === null ? undefined : { signal });
    const envelope = bridgeRecord(response.body);
    if (!response.ok || envelope?.ok !== true) {
      const details = bridgeRecord(envelope?.details);
      const reasonCode = typeof details?.reasonCode === 'string' && isSSHelperReasonCode(details.reasonCode)
        ? details.reasonCode
        : 'INTERNAL_ERROR';
      throw createSSHelperError(reasonCode, {
        stage: typeof details?.stage === 'string' ? details.stage : 'llm.bridge.http.response',
        requestId: typeof details?.requestId === 'string' ? details.requestId : requestId,
        ...(typeof details?.httpStatus === 'number' ? { httpStatus: details.httpStatus } : {}),
      });
    }
    const data = bridgeRecord(envelope.data);
    const status = typeof data?.status === 'number' ? data.status : 502;
    const responseBody = data?.body;
    const serializedBody = responseBody === undefined || responseBody === null
      ? null
      : typeof responseBody === 'string'
        ? responseBody
        : JSON.stringify(responseBody);
    const contentType = typeof data?.contentType === 'string'
      ? data.contentType
      : 'application/json';
    return new Response(serializedBody, {
      status,
      headers: { 'content-type': contentType },
    });
  }) as typeof fetch;
}
