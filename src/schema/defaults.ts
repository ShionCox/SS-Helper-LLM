import type { LLMHubSettings } from './types';

export type LlmSettingsDefaults = Required<Pick<
    LLMHubSettings,
    'enabled' | 'streamingEnabled' | 'maxRequestsPerMinute' | 'globalProfile' | 'maxTokensMode' | 'maxTokens' | 'timeoutMs' | 'resourcePolicies'
>> & { requestLogging: Required<import('./types').LLMRequestLoggingSettings> };

export const DEFAULT_LLM_SETTINGS: Readonly<LlmSettingsDefaults> = Object.freeze({
    enabled: true,
    streamingEnabled: true,
    maxRequestsPerMinute: 0,
    globalProfile: 'balanced',
    maxTokensMode: 'adaptive',
    maxTokens: 2048,
    timeoutMs: 60000,
    resourcePolicies: Object.freeze({}),
    requestLogging: Object.freeze({
        enabled: true,
        detailMode: 'full',
        maxEntries: 500,
        retentionDays: 30,
        maxBytes: 100 * 1024 * 1024,
    }),
});
