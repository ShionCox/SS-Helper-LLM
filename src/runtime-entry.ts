import config from '../plugin.config.json' with { type: 'json' };
import { ensureHostedCore, readSSHelperFailure, type SessionBootstrap } from '@ss-helper/sdk';
import { logger, safeFailureLogDetail, traceLlmStartup } from './runtime/logger';
import { startLlmPlugin } from './ss-helper/plugin';

type LlmRuntimeCapability = 'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'tavern.plugin.request' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write';

let activeBootstrap: Promise<SessionBootstrap<LlmRuntimeCapability>> | undefined;

export async function startLLMHubRuntime(): Promise<SessionBootstrap<LlmRuntimeCapability>> {
    try {
        traceLlmStartup('runtime:start');
        await ensureHostedCore();
        traceLlmStartup('runtime:core-ready');
        activeBootstrap ??= startLlmPlugin({ pluginVersion: config.manifest.version });
        const bootstrap = await activeBootstrap;
        traceLlmStartup('runtime:session-ready');
        void bootstrap.closed.catch((error) => logger.error(
            'SS-Helper Core reconnect stopped',
            safeFailureLogDetail(error, { reasonCode: 'CORE_BRIDGE_UNAVAILABLE', stage: 'llm.runtime.reconnect' }),
        ));
        return bootstrap;
    } catch (error) {
        activeBootstrap = undefined;
        const failure = readSSHelperFailure(error, {
            reasonCode: 'CORE_BRIDGE_UNAVAILABLE',
            stage: 'llm.runtime.start',
        })!;
        logger.error('Unable to connect to SS-Helper Core', failure);
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
