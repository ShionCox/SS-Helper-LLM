import type { LLMRequestLogQueryOptions } from '../schema/types';
import { getActiveLlmStorage, type LlmRequestLogRecord } from './database';

function sortTimestamp(row: Record<string, unknown>): number {
    return Number(row.sortTs ?? row.finishedAt ?? row.startedAt ?? row.queuedAt ?? row.updatedAt ?? Date.now());
}

export async function appendLlmRequestLog(row: Record<string, unknown>): Promise<void> {
    const { database, fallbackDatabase, cutover } = await getActiveLlmStorage();
    const table = cutover ? database.llm_request_logs : fallbackDatabase!.table<LlmRequestLogRecord, string>('llm_request_logs');
    const now = Date.now();
    await table.put({ ...row, sortTs: sortTimestamp(row), createdAt: Number(row.createdAt ?? now), updatedAt: now } as unknown as LlmRequestLogRecord);
}

export async function queryLlmRequestLogs(options: LLMRequestLogQueryOptions = {}): Promise<LlmRequestLogRecord[]> {
    const { database, fallbackDatabase, cutover } = await getActiveLlmStorage();
    const table = cutover ? database.llm_request_logs : fallbackDatabase!.table<LlmRequestLogRecord, string>('llm_request_logs');
    let rows = await table.toArray();
    rows.sort((left, right) => right.sortTs - left.sortTs);
    if (options.sourcePluginId) rows = rows.filter((row) => row.sourcePluginId === options.sourcePluginId);
    if (options.state && options.state !== 'all') rows = rows.filter((row) => row.state === options.state);
    if (options.fromTs) rows = rows.filter((row) => row.sortTs >= options.fromTs!);
    if (options.toTs) rows = rows.filter((row) => row.sortTs <= options.toTs!);
    if (options.search) {
        const query = options.search.toLowerCase();
        rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
    }
    if (options.order === 'asc') rows.reverse();
    if (options.offset) rows = rows.slice(options.offset);
    if (options.limit) rows = rows.slice(0, options.limit);
    return rows;
}

export async function clearLlmRequestLogs(): Promise<number> {
    const { database, fallbackDatabase, cutover } = await getActiveLlmStorage();
    const table = cutover ? database.llm_request_logs : fallbackDatabase!.table<LlmRequestLogRecord, string>('llm_request_logs');
    const count = await table.count();
    await table.clear();
    return count;
}

export async function trimLlmRequestLogs(limit: number): Promise<void> {
    const { database, fallbackDatabase, cutover } = await getActiveLlmStorage();
    const table = cutover ? database.llm_request_logs : fallbackDatabase!.table<LlmRequestLogRecord, string>('llm_request_logs');
    const rows = await table.orderBy('sortTs').reverse().toArray();
    await table.bulkDelete(rows.slice(Math.max(0, limit)).map((row) => row.logId));
}
