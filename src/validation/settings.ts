import type { BudgetConfig } from '../budget/budget-manager';
import type { AssignmentEntry, GlobalAssignments, GlobalMaxTokensControl, LLMHubSettings, PluginAssignment, ResourceConfig, SilentPermissionGrant, TaskAssignment } from '../schema/types';

const TOP_LEVEL = new Set(['enabled', 'timeoutMs', 'maxTokensMode', 'maxTokens', 'resultDisplay', 'globalProfile', 'maxTokensControl', 'resources', 'globalAssignments', 'pluginAssignments', 'taskAssignments', 'budgets', 'silentPermissions']);
const RESOURCE_KEYS = new Set(['id', 'type', 'source', 'apiType', 'label', 'baseUrl', 'model', 'enabled', 'rerankPath', 'capabilities', 'customParams']);
const BUDGET_KEYS = new Set(['maxRPM', 'maxTokens', 'maxLatencyMs']);
const MAX_JSON_BYTES = 256 * 1024;

function invalid(message: string, code = 'PAYLOAD_INVALID'): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${name} 无效`);
  return value.trim();
}

function positiveInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > max) invalid(`${name} 必须是有效的正整数`);
  return value;
}

function nonNegativeNumber(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) invalid(`${name} 必须是有限的非负数`);
  return value;
}

function enumString<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  const normalized = string(value, name, 64) as T;
  if (!allowed.includes(normalized)) invalid(`${name} 无效`);
  return normalized;
}

function rejectDeprecated(value: unknown, depth = 0): void {
  if (depth > 12) invalid('设置嵌套过深');
  if (Array.isArray(value)) { if (value.length > 1_000) invalid('设置数组过长'); value.forEach((item) => rejectDeprecated(item, depth + 1)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'maxCost') invalid('maxCost 已废弃，请使用 Token、延迟和 RPM 限制。', 'LLM_DEPRECATED_MAX_COST');
    rejectDeprecated(nested, depth + 1);
  }
}

function validateResource(value: unknown): ResourceConfig {
  const record = object(value, 'resource');
  for (const key of Object.keys(record)) if (!RESOURCE_KEYS.has(key)) invalid(`resource.${key} 不受支持`);
  const type = string(record.type, 'resource.type', 32);
  const source = string(record.source, 'resource.source', 32);
  if (!['generation', 'embedding', 'rerank'].includes(type) || source !== 'custom') invalid('resource 类型无效');
  const apiType = record.apiType === undefined ? 'openai' : string(record.apiType, 'resource.apiType', 32);
  if (!['openai', 'deepseek', 'gemini', 'claude', 'generic'].includes(apiType)) invalid('resource.apiType 无效');
  let baseUrl: string | undefined;
  if (record.baseUrl !== undefined) {
    baseUrl = string(record.baseUrl, 'resource.baseUrl', 2_048);
    try { const parsed = new URL(baseUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid('resource.baseUrl 必须使用 HTTPS'); }
    catch { invalid('resource.baseUrl 无效'); }
  }
  const capabilities = record.capabilities === undefined ? undefined : (() => {
    if (!Array.isArray(record.capabilities) || record.capabilities.length > 16) invalid('resource.capabilities 无效');
    const allowed = new Set(['chat', 'json', 'tools', 'embeddings', 'rerank', 'vision', 'reasoning']);
    return [...new Set(record.capabilities.map((item) => string(item, 'resource.capability', 32)))].filter((item) => { if (!allowed.has(item)) invalid('resource.capability 无效'); return true; }) as ResourceConfig['capabilities'];
  })();
  if (record.customParams !== undefined) rejectDeprecated(record.customParams);
  const id = string(record.id, 'resource.id', 128);
  if (id === '__builtin_tavern__') invalid('resource.id 保留给酒馆资源');
  return {
    id, type: type as ResourceConfig['type'], source: 'custom', apiType: apiType as ResourceConfig['apiType'],
    label: string(record.label, 'resource.label', 128), ...(baseUrl ? { baseUrl } : {}),
    ...(record.model === undefined || record.model === '' ? {} : { model: string(record.model, 'resource.model', 256) }),
    ...(record.enabled === undefined ? {} : { enabled: typeof record.enabled === 'boolean' ? record.enabled : invalid('resource.enabled 必须是布尔值') }),
    ...(record.rerankPath === undefined ? {} : { rerankPath: string(record.rerankPath, 'resource.rerankPath', 512) }),
    ...(capabilities ? { capabilities } : {}), ...(record.customParams === undefined ? {} : { customParams: structuredClone(object(record.customParams, 'resource.customParams')) }),
  };
}

function validateAssignmentEntry(value: unknown, name: string): AssignmentEntry {
  const input = object(value, name);
  for (const key of Object.keys(input)) if (!['resourceId', 'model'].includes(key)) invalid(`${name}.${key} 不受支持`);
  return { resourceId: string(input.resourceId, `${name}.resourceId`, 128), ...(input.model === undefined ? {} : { model: string(input.model, `${name}.model`, 256) }) };
}

function validateGlobalAssignments(value: unknown): GlobalAssignments {
  const input = object(value, 'globalAssignments');
  for (const key of Object.keys(input)) if (!['generation', 'embedding', 'rerank'].includes(key)) invalid(`globalAssignments.${key} 不受支持`);
  return {
    ...(input.generation === undefined ? {} : { generation: validateAssignmentEntry(input.generation, 'globalAssignments.generation') }),
    ...(input.embedding === undefined ? {} : { embedding: validateAssignmentEntry(input.embedding, 'globalAssignments.embedding') }),
    ...(input.rerank === undefined ? {} : { rerank: validateAssignmentEntry(input.rerank, 'globalAssignments.rerank') }),
  };
}

function validatePluginAssignments(value: unknown): PluginAssignment[] {
  if (!Array.isArray(value) || value.length > 500) invalid('pluginAssignments 无效');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const input = object(item, `pluginAssignments[${index}]`);
    for (const key of Object.keys(input)) if (!['pluginId', 'generation', 'embedding', 'rerank'].includes(key)) invalid(`pluginAssignments[${index}].${key} 不受支持`);
    const pluginId = string(input.pluginId, `pluginAssignments[${index}].pluginId`, 128);
    if (ids.has(pluginId)) invalid('pluginAssignments.pluginId 必须唯一');
    ids.add(pluginId);
    return {
      pluginId,
      ...(input.generation === undefined ? {} : { generation: validateAssignmentEntry(input.generation, `pluginAssignments[${index}].generation`) }),
      ...(input.embedding === undefined ? {} : { embedding: validateAssignmentEntry(input.embedding, `pluginAssignments[${index}].embedding`) }),
      ...(input.rerank === undefined ? {} : { rerank: validateAssignmentEntry(input.rerank, `pluginAssignments[${index}].rerank`) }),
    };
  });
}

function validateTaskAssignments(value: unknown): TaskAssignment[] {
  if (!Array.isArray(value) || value.length > 1_000) invalid('taskAssignments 无效');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const input = object(item, `taskAssignments[${index}]`);
    for (const key of Object.keys(input)) if (!['pluginId', 'taskKey', 'taskKind', 'resourceId', 'model', 'maxTokens', 'isStale', 'staleReason'].includes(key)) invalid(`taskAssignments[${index}].${key} 不受支持`);
    const pluginId = string(input.pluginId, `taskAssignments[${index}].pluginId`, 128);
    const taskKey = string(input.taskKey, `taskAssignments[${index}].taskKey`, 256);
    const taskKind = enumString(input.taskKind, `taskAssignments[${index}].taskKind`, ['generation', 'embedding', 'rerank'] as const);
    const id = `${pluginId}::${taskKey}`;
    if (ids.has(id)) invalid('taskAssignments 组合键必须唯一');
    ids.add(id);
    if (input.isStale !== undefined && typeof input.isStale !== 'boolean') invalid(`taskAssignments[${index}].isStale 必须是布尔值`);
    return {
      pluginId, taskKey, taskKind,
      ...(input.resourceId === undefined ? {} : { resourceId: string(input.resourceId, `taskAssignments[${index}].resourceId`, 128) }),
      ...(input.model === undefined ? {} : { model: string(input.model, `taskAssignments[${index}].model`, 256) }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: positiveInteger(input.maxTokens, `taskAssignments[${index}].maxTokens`, 1_000_000) }),
      isStale: input.isStale === true,
      ...(input.staleReason === undefined ? {} : { staleReason: string(input.staleReason, `taskAssignments[${index}].staleReason`, 512) }),
    };
  });
}

function validateMaxTokensControl(value: unknown): GlobalMaxTokensControl {
  const input = object(value, 'maxTokensControl');
  for (const key of Object.keys(input)) if (!['mode', 'manualValue', 'adaptive'].includes(key)) invalid(`maxTokensControl.${key} 不受支持`);
  const adaptive = input.adaptive === undefined ? undefined : (() => {
    const nested = object(input.adaptive, 'maxTokensControl.adaptive');
    for (const key of Object.keys(nested)) if (!['min', 'max', 'charDivisor', 'schemaCharDivisor', 'messageBonus'].includes(key)) invalid(`maxTokensControl.adaptive.${key} 不受支持`);
    return {
      ...(nested.min === undefined ? {} : { min: positiveInteger(nested.min, 'maxTokensControl.adaptive.min', 1_000_000) }),
      ...(nested.max === undefined ? {} : { max: positiveInteger(nested.max, 'maxTokensControl.adaptive.max', 1_000_000) }),
      ...(nested.charDivisor === undefined ? {} : { charDivisor: positiveInteger(nested.charDivisor, 'maxTokensControl.adaptive.charDivisor', 1_000_000) }),
      ...(nested.schemaCharDivisor === undefined ? {} : { schemaCharDivisor: positiveInteger(nested.schemaCharDivisor, 'maxTokensControl.adaptive.schemaCharDivisor', 1_000_000) }),
      ...(nested.messageBonus === undefined ? {} : { messageBonus: nonNegativeNumber(nested.messageBonus, 'maxTokensControl.adaptive.messageBonus', 1_000_000) }),
    };
  })();
  return {
    ...(input.mode === undefined ? {} : { mode: enumString(input.mode, 'maxTokensControl.mode', ['inherit', 'manual', 'adaptive'] as const) }),
    ...(input.manualValue === undefined ? {} : { manualValue: positiveInteger(input.manualValue, 'maxTokensControl.manualValue', 1_000_000) }),
    ...(adaptive === undefined ? {} : { adaptive }),
  };
}

function validateSilentPermissions(value: unknown): SilentPermissionGrant[] {
  if (!Array.isArray(value) || value.length > 1_000) invalid('silentPermissions 无效');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const input = object(item, `silentPermissions[${index}]`);
    for (const key of Object.keys(input)) if (!['pluginId', 'taskKey', 'grantedAt'].includes(key)) invalid(`silentPermissions[${index}].${key} 不受支持`);
    const pluginId = string(input.pluginId, `silentPermissions[${index}].pluginId`, 128);
    const taskKey = string(input.taskKey, `silentPermissions[${index}].taskKey`, 256);
    const id = `${pluginId}::${taskKey}`;
    if (ids.has(id)) invalid('silentPermissions 组合键必须唯一');
    ids.add(id);
    return { pluginId, taskKey, grantedAt: positiveInteger(input.grantedAt, `silentPermissions[${index}].grantedAt`, Number.MAX_SAFE_INTEGER) };
  });
}

export function validateBudgetConfigs(value: unknown): Record<string, BudgetConfig> {
  if (value === undefined) return {};
  const input = object(value, 'budgets'); const result: Record<string, BudgetConfig> = {};
  if (Object.keys(input).length > 500) invalid('budgets 条目过多');
  for (const [consumer, raw] of Object.entries(input)) {
    string(consumer, 'budget consumer', 128); const config = object(raw, `budgets.${consumer}`);
    for (const key of Object.keys(config)) if (!BUDGET_KEYS.has(key)) invalid(`budgets.${consumer}.${key} 不受支持`);
    result[consumer] = {
      ...(config.maxRPM === undefined ? {} : { maxRPM: positiveInteger(config.maxRPM, `budgets.${consumer}.maxRPM`, 60_000) }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: positiveInteger(config.maxTokens, `budgets.${consumer}.maxTokens`, 1_000_000) }),
      ...(config.maxLatencyMs === undefined ? {} : { maxLatencyMs: positiveInteger(config.maxLatencyMs, `budgets.${consumer}.maxLatencyMs`, 600_000) }),
    };
  }
  return result;
}

export function validateLlmSettings(value: unknown): LLMHubSettings {
  rejectDeprecated(value); const input = object(value, 'settings');
  if (JSON.stringify(input).length > MAX_JSON_BYTES) invalid('设置内容过大');
  for (const key of Object.keys(input)) if (!TOP_LEVEL.has(key)) invalid(`settings.${key} 不受支持`);
  const result = structuredClone(input) as LLMHubSettings;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') invalid('enabled 必须是布尔值');
  if (input.timeoutMs !== undefined) result.timeoutMs = positiveInteger(input.timeoutMs, 'timeoutMs', 600_000);
  if (input.maxTokens !== undefined) result.maxTokens = positiveInteger(input.maxTokens, 'maxTokens', 1_000_000);
  if (input.maxTokensMode !== undefined) result.maxTokensMode = enumString(input.maxTokensMode, 'maxTokensMode', ['inherit', 'manual', 'adaptive'] as const);
  if (input.resultDisplay !== undefined) result.resultDisplay = enumString(input.resultDisplay, 'resultDisplay', ['auto', 'silent', 'compact', 'fullscreen'] as const);
  if (input.globalProfile !== undefined) result.globalProfile = enumString(input.globalProfile, 'globalProfile', ['precise', 'creative', 'balanced', 'economy'] as const);
  if (input.maxTokensControl !== undefined) result.maxTokensControl = validateMaxTokensControl(input.maxTokensControl);
  if (input.resources !== undefined) {
    if (!Array.isArray(input.resources) || input.resources.length > 200) invalid('resources 无效');
    result.resources = input.resources.map(validateResource);
    if (new Set(result.resources.map((item) => item.id)).size !== result.resources.length) invalid('resource.id 必须唯一');
  }
  if (input.globalAssignments !== undefined) result.globalAssignments = validateGlobalAssignments(input.globalAssignments);
  if (input.pluginAssignments !== undefined) result.pluginAssignments = validatePluginAssignments(input.pluginAssignments);
  if (input.taskAssignments !== undefined) result.taskAssignments = validateTaskAssignments(input.taskAssignments);
  result.budgets = validateBudgetConfigs(input.budgets);
  if (input.silentPermissions !== undefined) result.silentPermissions = validateSilentPermissions(input.silentPermissions);
  return result;
}

export function migrateStoredLlmSettings(value: unknown): { settings: LLMHubSettings; migrated: boolean } {
  const clone = structuredClone(object(value ?? {}, 'settings'));
  let migrated = false;
  const clean = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(clean); return; }
    if (!item || typeof item !== 'object') return;
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (key === 'maxCost' || key === 'detailedLogs') { delete (item as Record<string, unknown>)[key]; migrated = true; }
      else clean((item as Record<string, unknown>)[key]);
    }
  };
  clean(clone);
  return { settings: validateLlmSettings(clone), migrated };
}
