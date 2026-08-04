import type { ProviderResponseDiagnostics } from './types';

function byteLength(value: unknown): number | undefined {
    try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        return new TextEncoder().encode(serialized).byteLength;
    } catch {
        return undefined;
    }
}

export function responseDiagnostics(
    response: Response,
    body: unknown,
    options: { readonly streamed?: boolean; readonly streamEventCount?: number } = {},
): ProviderResponseDiagnostics {
    const receivedBytes = byteLength(body);
    return {
        httpStatus: response.status,
        ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type')! } : {}),
        ...(receivedBytes === undefined ? {} : { receivedBytes }),
        ...(options.streamed === undefined ? {} : { streamed: options.streamed }),
        ...(options.streamEventCount === undefined ? {} : { streamEventCount: options.streamEventCount }),
        receivedAt: Date.now(),
    };
}

export interface ProviderResponseDebug {
    readonly rawResponseText?: string;
    readonly providerResponse?: unknown;
}

/** Keep response evidence available to the request logger without serializing it as public error details. */
export function attachProviderResponseDebug<T extends Error>(error: T, debug: ProviderResponseDebug): T {
    for (const [key, value] of Object.entries(debug)) {
        if (value === undefined) continue;
        Object.defineProperty(error, key, { value, configurable: true, enumerable: false });
    }
    return error;
}
