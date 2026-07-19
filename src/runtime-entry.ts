import config from '../plugin.config.json' with { type: 'json' };
import { ensureHostedCore, type SessionBootstrap } from '@ss-helper/sdk';
import { logger } from './runtime/logger';
import { startLlmPlugin } from './ss-helper/plugin';

type LlmRuntimeCapability = 'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'core.ui.notification.v1';

let activeBootstrap: Promise<SessionBootstrap<LlmRuntimeCapability>> | undefined;

export async function startLLMHubRuntime(): Promise<SessionBootstrap<LlmRuntimeCapability>> {
    try {
        await ensureHostedCore();
        activeBootstrap ??= startLlmPlugin({ pluginVersion: config.manifest.version });
        const bootstrap = await activeBootstrap;
        void bootstrap.closed.catch((error) => logger.error('SS-Helper Core reconnect stopped', error));
        return bootstrap;
    } catch (error) {
        activeBootstrap = undefined;
        logger.error('Unable to connect to SS-Helper Core', error);
        throw error;
    }
}

export async function stopLLMHubRuntime(): Promise<void> {
    const current = activeBootstrap;
    activeBootstrap = undefined;
    if (current !== undefined) (await current).dispose();
}

if (typeof window !== 'undefined') void startLLMHubRuntime().catch(() => undefined);
