import type { LLMHubSettings } from './types';

export type LlmSettingsDefaults = Required<Pick<
    LLMHubSettings,
    'enabled' | 'globalProfile' | 'maxTokensMode' | 'maxTokens' | 'timeoutMs' | 'resultDisplay' | 'detailedLogs'
>>;

export const DEFAULT_LLM_SETTINGS: Readonly<LlmSettingsDefaults> = Object.freeze({
    enabled: true,
    globalProfile: 'balanced',
    maxTokensMode: 'adaptive',
    maxTokens: 2048,
    timeoutMs: 60000,
    resultDisplay: 'auto',
    detailedLogs: false,
});
