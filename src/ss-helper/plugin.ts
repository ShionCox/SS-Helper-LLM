import { bootstrapSSHelper, type PluginSession, type SessionBootstrap } from '@ss-helper/sdk';
import { logger } from '../runtime/logger';
import { createLlmSettingsAdapter, LLM_ADVANCED_ROUTING_KEY, LLM_SETTINGS_SCHEMA, loadLlmSettings } from './settings';
import { exposeLlmServices, type LlmServiceHandlers } from './services';
import { createProductionLlmServices } from './llm-service-runtime';

const POPUP_TOKEN = { kind: 'popup', provider: 'ss-helper.llm', name: 'advanced-routing', version: 1 } as const;

export interface StartLlmPluginOptions {
    pluginVersion: string;
    services?: LlmServiceHandlers;
    target?: { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string, listener: EventListener): void };
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export function registerLlmPopup(session: PluginSession, storage: Pick<Storage, 'getItem' | 'setItem'>): () => void {
    return session.registerPopup({
        token: POPUP_TOKEN,
        title: 'LLM 高级路由配置',
        ariaLabel: '编辑 LLM 高级路由配置',
        render(container): () => void {
            const textarea = document.createElement('textarea');
            textarea.setAttribute('aria-label', 'LLM 路由 JSON');
            textarea.value = storage.getItem(LLM_ADVANCED_ROUTING_KEY) ?? '{}';
            textarea.style.width = '100%';
            textarea.style.minHeight = '18rem';
            const save = document.createElement('button');
            save.type = 'button';
            save.textContent = '保存';
            const status = document.createElement('p');
            const onSave = (): void => {
                try { JSON.parse(textarea.value); storage.setItem(LLM_ADVANCED_ROUTING_KEY, textarea.value); status.textContent = '已保存'; }
                catch { status.textContent = 'JSON 格式无效'; }
            };
            save.addEventListener('click', onSave);
            container.append(textarea, save, status);
            return () => save.removeEventListener('click', onSave);
        },
    });
}

export async function startLlmPlugin(options: StartLlmPluginOptions): Promise<SessionBootstrap<'tavern.generation.read' | 'tavern.generation.execute'>> {
    const storage = options.storage ?? localStorage;
    return bootstrapSSHelper({
        id: 'ss-helper.llm',
        displayName: 'SS-Helper LLM',
        pluginVersion: options.pluginVersion,
        capabilities: ['tavern.generation.read', 'tavern.generation.execute'],
    }, (session) => {
        const cleanups: Array<() => void> = [];
        try {
            cleanups.push(session.registerSettings(LLM_SETTINGS_SCHEMA, createLlmSettingsAdapter(storage)));
            cleanups.push(registerLlmPopup(session, storage));
            cleanups.push(exposeLlmServices(session, options.services ?? createProductionLlmServices(session, {
                settings: () => ({ enabled: loadLlmSettings(storage).enabled !== false }),
            })));
        } catch (error) {
            cleanups.reverse().forEach((cleanup) => cleanup());
            session.dispose();
            throw error;
        }
        void session.closed.then(() => cleanups.reverse().forEach((cleanup) => cleanup())).catch((error) => logger.error('Session cleanup failed', error));
    }, { target: options.target });
}
