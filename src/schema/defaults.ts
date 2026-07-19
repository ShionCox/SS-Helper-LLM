import type { LLMHubSettings } from './types';

export type LlmSettingsDefaults = Required<Pick<
    LLMHubSettings,
    'enabled' | 'generationSource' | 'globalProfile' | 'maxTokensMode' | 'maxTokens' | 'timeoutMs' | 'resultDisplay'
>> & { requestLogging: Required<import('./types').LLMRequestLoggingSettings> };

export const DEFAULT_LLM_SETTINGS: Readonly<LlmSettingsDefaults> = Object.freeze({
    enabled: true,
    generationSource: 'tavern',
    globalProfile: 'balanced',
    maxTokensMode: 'adaptive',
    maxTokens: 2048,
    timeoutMs: 60000,
    resultDisplay: 'auto',
    requestLogging: Object.freeze({
        enabled: true,
        detailMode: 'full',
        maxEntries: 500,
        retentionDays: 30,
        maxBytes: 100 * 1024 * 1024,
    }),
});
