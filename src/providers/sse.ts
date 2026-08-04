import { createSSHelperError } from '@ss-helper/sdk';
import { attachProviderResponseDebug } from './provider-response-diagnostics';

export interface ServerSentEvent {
    readonly event?: string;
    readonly data: string;
}

function invalidSse(text: string, stage: string, resourceId: string): never {
    throw attachProviderResponseDebug(
        createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage, resourceId }),
        text ? { rawResponseText: text } : {},
    );
}

/** Parse a completed, size-bounded SSE response without retaining comments. */
export function parseServerSentEvents(text: string, stage: string, resourceId: string): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    let eventName: string | undefined;
    let data: string[] = [];
    const flush = (): void => {
        if (data.length > 0) events.push({ ...(eventName ? { event: eventName } : {}), data: data.join('\n') });
        eventName = undefined;
        data = [];
    };
    for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
        if (line === '') { flush(); continue; }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
        if (field === 'event') eventName = value;
        else if (field === 'data') data.push(value);
    }
    flush();
    if (events.length === 0) invalidSse(text, stage, resourceId);
    return events;
}

export function parseSseJson(text: string, stage: string, resourceId: string): readonly Record<string, unknown>[] {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            return Array.isArray(parsed)
                ? parsed.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
                : parsed !== null && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
        } catch { invalidSse(text, stage, resourceId); }
    }
    const output: Record<string, unknown>[] = [];
    for (const event of parseServerSentEvents(text, stage, resourceId)) {
        if (!event.data || event.data === '[DONE]') continue;
        try {
            const parsed = JSON.parse(event.data) as unknown;
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                output.push({ ...(event.event ? { __event: event.event } : {}), ...(parsed as Record<string, unknown>) });
            }
        } catch { invalidSse(text, stage, resourceId); }
    }
    if (output.length === 0) invalidSse(text, stage, resourceId);
    return output;
}
