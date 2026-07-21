import type { ChatIndicatorResolution, ChatIndicatorTarget, PluginSession } from '@ss-helper/sdk';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';

export function registerLlmChatIndicator(
  session: Pick<PluginSession, 'registerChatIndicator'>,
  repository: Pick<LlmWorkspaceRepository, 'loadSettings' | 'subscribeSettings'>,
): () => void {
  if (session.registerChatIndicator === undefined) return () => undefined;
  return session.registerChatIndicator({
    label: 'LLM',
    icon: 'microchip',
    kind: 'dependency',
    order: 20,
    resolve: async (targets: readonly ChatIndicatorTarget[]): Promise<readonly ChatIndicatorResolution[]> => {
      const settings = await repository.loadSettings();
      const state = settings.enabled === false ? 'hidden' as const : 'enabled' as const;
      return targets.map((target) => ({ targetKey: target.key, state }));
    },
    subscribe: (listener) => repository.subscribeSettings(() => listener()),
  });
}
