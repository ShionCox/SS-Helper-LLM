import { createSSHelperError, type ProviderPrivacyPolicy } from '@ss-helper/sdk';

export const DEFAULT_PROVIDER_PRIVACY_POLICY: ProviderPrivacyPolicy = Object.freeze({
    conversationStateMode: 'local_replay',
    storeProviderState: false,
    allowRemoteRetention: false,
});

export function normalizeProviderPrivacyPolicy(value: ProviderPrivacyPolicy | undefined): ProviderPrivacyPolicy {
    if (!value) return DEFAULT_PROVIDER_PRIVACY_POLICY;
    const providerManaged = value.conversationStateMode === 'provider_managed';
    if (providerManaged && (!value.storeProviderState || !value.allowRemoteRetention)) {
        throw createSSHelperError('LLM_PROVIDER_STATE_NOT_AUTHORIZED', {
            stage: 'llm.tools.privacy.validate',
        });
    }
    if (!providerManaged && (value.storeProviderState || value.allowRemoteRetention)) {
        throw createSSHelperError('LLM_PROVIDER_STATE_NOT_AUTHORIZED', {
            stage: 'llm.tools.privacy.validate',
        });
    }
    return Object.freeze({ ...value });
}

export function providerStoresState(policy: ProviderPrivacyPolicy): boolean {
    if (policy.conversationStateMode !== 'provider_managed') return false;
    if (!policy.storeProviderState || !policy.allowRemoteRetention) {
        throw createSSHelperError('LLM_PROVIDER_STATE_NOT_AUTHORIZED', {
            stage: 'llm.tools.privacy.provider_state',
        });
    }
    return true;
}
