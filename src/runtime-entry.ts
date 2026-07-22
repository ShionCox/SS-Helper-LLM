import config from '../plugin.config.json' with { type: 'json' };
import { ensureHostedCore, waitForTavernReady, type SessionBootstrap } from '@ss-helper/sdk';
import { logger } from './runtime/logger';
import { startLlmPlugin } from './ss-helper/plugin';

type LlmRuntimeCapability = 'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write';

let activeBootstrap: Promise<SessionBootstrap<LlmRuntimeCapability>> | undefined;

function safeCode(error: unknown, fallback = 'LLM_START_FAILED'): string {
    const value = error && typeof error === 'object' && 'code' in error ? (error as { readonly code?: unknown }).code : undefined;
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : fallback;
}

export async function startLLMHubRuntime(): Promise<SessionBootstrap<LlmRuntimeCapability>> {
    try {
        await waitForTavernReady();
        await ensureHostedCore();
        activeBootstrap ??= startLlmPlugin({ pluginVersion: config.manifest.version });
        const bootstrap = await activeBootstrap;
        void bootstrap.closed.catch((error) => logger.error('SS-Helper Core reconnect stopped', error));
        return bootstrap;
    } catch (error) {
        activeBootstrap = undefined;
        logger.error('Unable to connect to SS-Helper Core', { code: safeCode(error) });
        throw error;
    }
}

export async function stopLLMHubRuntime(): Promise<void> {
    const current = activeBootstrap;
    activeBootstrap = undefined;
    if (current !== undefined) (await current).dispose();
}

if (typeof window !== 'undefined') {
    // startLLMHubRuntime records a safe structured diagnostic on failure. The
    // catch prevents a background extension startup from surfacing as an
    // unhandled renderer rejection.
    void startLLMHubRuntime().catch(() => undefined);
}
