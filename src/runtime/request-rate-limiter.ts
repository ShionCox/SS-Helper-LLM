import { createSSHelperError } from '@ss-helper/sdk';

const MINUTE_MS = 60_000;

/**
 * 全局请求启动限速器。0 表示不限速；正数按均匀间隔分配请求槽位，
 * 避免同一分钟内的突发请求集中触发第三方服务的 429。
 */
export class RequestRateLimiter {
    private maxRequestsPerMinute = 0;
    private nextAvailableAt = 0;

    setMaxRequestsPerMinute(value: number): void {
        const normalized = Number.isInteger(value) && value > 0 ? value : 0;
        if (normalized === this.maxRequestsPerMinute) return;
        this.maxRequestsPerMinute = normalized;
        this.nextAvailableAt = 0;
    }

    getMaxRequestsPerMinute(): number {
        return this.maxRequestsPerMinute;
    }

    async acquire(signal?: AbortSignal, requestId?: string): Promise<void> {
        if (signal?.aborted) throw this.aborted(requestId);
        if (this.maxRequestsPerMinute === 0) return;

        const intervalMs = Math.ceil(MINUTE_MS / this.maxRequestsPerMinute);
        const now = Date.now();
        const availableAt = Math.max(now, this.nextAvailableAt);
        this.nextAvailableAt = availableAt + intervalMs;
        const waitMs = availableAt - now;
        if (waitMs <= 0) return;

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, waitMs);
            const onAbort = (): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(this.aborted(requestId));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    private aborted(requestId?: string) {
        return createSSHelperError('REQUEST_ABORTED', {
            stage: 'llm.rate_limit.wait',
            ...(requestId ? { requestId } : {}),
        });
    }
}
