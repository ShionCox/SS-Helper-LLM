import type { ProviderToolDialect } from '@ss-helper/sdk';

export type ProviderManifestId = 'openai' | 'claude' | 'gemini' | 'deepseek' | 'kimi' | 'glm' | 'xai' | 'generic';
export interface ProviderManifest {
  readonly id: ProviderManifestId;
  readonly protocol: ProviderToolDialect;
  readonly aliases: readonly string[];
  readonly supports: { readonly chat: boolean; readonly structured: boolean; readonly tools: boolean; readonly streaming: boolean; readonly strict: boolean; readonly parallel: boolean; readonly reasoning: boolean };
  readonly reasoning: {
    readonly defaultMode: 'provider_default' | 'enabled' | 'disabled';
    readonly modes: readonly ('provider_default' | 'enabled' | 'disabled')[];
    readonly efforts: readonly ('provider_default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
    readonly transport: string;
    readonly replay: 'none' | 'required' | 'opaque';
  };
}

const MANIFESTS: readonly ProviderManifest[] = Object.freeze([
  { id: 'openai', protocol: 'openai_responses', aliases: ['openai'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: true, parallel: true, reasoning: true }, reasoning: { defaultMode: 'provider_default', modes: ['provider_default', 'enabled', 'disabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'openai_chat_or_responses', replay: 'opaque' } },
  { id: 'claude', protocol: 'anthropic_messages', aliases: ['anthropic', 'claude'], supports: { chat: true, structured: false, tools: true, streaming: true, strict: true, parallel: false, reasoning: true }, reasoning: { defaultMode: 'provider_default', modes: ['provider_default', 'enabled', 'disabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'claude_adaptive_or_budget', replay: 'required' } },
  { id: 'gemini', protocol: 'gemini_interactions', aliases: ['google', 'gemini'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: false, parallel: true, reasoning: true }, reasoning: { defaultMode: 'provider_default', modes: ['provider_default', 'enabled', 'disabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'gemini_level_or_budget', replay: 'opaque' } },
  { id: 'deepseek', protocol: 'deepseek_chat', aliases: ['deepseek'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: false, parallel: false, reasoning: true }, reasoning: { defaultMode: 'enabled', modes: ['provider_default', 'enabled', 'disabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'thinking_object', replay: 'required' } },
  { id: 'kimi', protocol: 'kimi_chat', aliases: ['moonshot', 'kimi'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: false, parallel: true, reasoning: true }, reasoning: { defaultMode: 'enabled', modes: ['provider_default', 'enabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'thinking_object', replay: 'required' } },
  { id: 'glm', protocol: 'glm_chat', aliases: ['zhipu', 'glm', '智谱'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: false, parallel: true, reasoning: true }, reasoning: { defaultMode: 'provider_default', modes: ['provider_default', 'enabled', 'disabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'thinking_object', replay: 'required' } },
  { id: 'xai', protocol: 'openai_chat_compatible', aliases: ['xai', 'grok'], supports: { chat: true, structured: true, tools: true, streaming: true, strict: false, parallel: true, reasoning: true }, reasoning: { defaultMode: 'enabled', modes: ['provider_default', 'enabled'], efforts: ['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'openai_chat', replay: 'none' } },
  { id: 'generic', protocol: 'openai_chat_compatible', aliases: [], supports: { chat: true, structured: false, tools: true, streaming: false, strict: false, parallel: false, reasoning: false }, reasoning: { defaultMode: 'provider_default', modes: ['provider_default'], efforts: ['provider_default'], transport: 'unknown', replay: 'none' } },
]);

export function providerManifest(value?: string): ProviderManifest {
  const token = String(value ?? '').trim().toLowerCase();
  return MANIFESTS.find((m) => m.aliases.some((a) => token === a || token.includes(a))) ?? MANIFESTS[MANIFESTS.length - 1];
}
