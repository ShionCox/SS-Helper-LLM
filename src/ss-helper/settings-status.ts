import {
  CORE_DISCOVERY_SYMBOL,
  LLM_TASK_STATUS_CHANGED_V0,
  describeSSHelperFailure,
  type CoreDiscoverySnapshot,
  type LlmTaskStatusSnapshot,
  type PluginSession,
  type SettingsStatusSnapshot,
} from '@ss-helper/sdk';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LlmServiceHandlers } from './services';
import type { LLMHubSettings } from '../schema/types';
import { BUILTIN_TAVERN_RESOURCE_ID } from '../router/router';

export type LlmSettingsStatusMap = Readonly<Record<string, SettingsStatusSnapshot>>;

export interface LlmSettingsStatusSource {
  loadStatus(): LlmSettingsStatusMap | Promise<LlmSettingsStatusMap>;
  subscribeStatus(listener: (status: LlmSettingsStatusMap) => void): () => void;
  refreshNow(): Promise<void>;
}

type DiscoveryTarget = EventTarget & { [CORE_DISCOVERY_SYMBOL]?: CoreDiscoverySnapshot };

const neutral = (value: string, description?: string): SettingsStatusSnapshot => Object.freeze({
  value,
  tone: 'neutral',
  ...(description ? { description } : {}),
});
const success = (value: string, description?: string): SettingsStatusSnapshot => Object.freeze({
  value,
  tone: 'success',
  ...(description ? { description } : {}),
});
const warning = (value: string, description: string): SettingsStatusSnapshot => Object.freeze({ value, tone: 'warning', description });
const error = (value: string, description: string): SettingsStatusSnapshot => Object.freeze({ value, tone: 'error', description });

function releaseVersion(version: string | undefined): string {
  const normalized = version?.trim().replace(/^[vV]+/u, '') ?? '';
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(normalized) ? `v${normalized}` : '未知';
}

function generationSnapshot(response: LlmTaskStatusSnapshot | undefined): SettingsStatusSnapshot {
  if (!response) return warning('状态不可用', 'LLM 实时状态暂不可用，请稍后重试。');
  const generationId = response.defaults.tool_turn ?? response.defaults.structured ?? response.defaults.completion;
  const resource = generationId === undefined ? undefined : response.resources.find((item) => item.resourceId === generationId);
  const task = response.tasks.find((entry) => entry.execution === 'completion' || entry.execution === 'structured' || entry.execution === 'tool_turn');
  if (resource !== undefined) {
    if (!resource.available) return error('生成不可用', `默认生成资源当前不可用；不会自动切换来源。`);
    return success('可用', `${resource.apiType} · ${resource.defaultModel ?? '默认模型'} 当前可用。`);
  }
  if (!task?.available) {
    return error('生成不可用', task?.failure?.reasonCode ? `当前生成任务不可用（${task.failure.reasonCode}）。` : '当前没有可用的生成任务。');
  }
  return success('可用', `${task.route?.provider ?? '生成资源'} 当前可用。`);
}

function settingsFailureDescription(error: unknown): string {
  const failure = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'llm.settings.status' });
  return `${failure.reasonCode} · ${failure.title}：${failure.reason} ${failure.action}${failure.requestId ? `（${failure.requestId}）` : ''}`;
}

function generationSourceSnapshot(
  settings: LLMHubSettings | undefined,
  tavernStatus: SettingsStatusSnapshot,
  capabilities: LlmTaskStatusSnapshot | undefined,
): SettingsStatusSnapshot {
  const resourceId = settings?.globalAssignments?.generation?.resourceId ?? BUILTIN_TAVERN_RESOURCE_ID;
  if (resourceId === BUILTIN_TAVERN_RESOURCE_ID) {
    return Object.freeze({ ...tavernStatus, description: '默认生成来源是酒馆当前连接。' });
  }
  const resource = settings?.resources?.find((item) => item.id === resourceId && item.type === 'generation');
  if (!resource) return error('自定义资源缺失', '默认生成来源指向的自定义生成资源已删除；不会自动切换到其他来源。');
  if (resource.enabled === false) return error('自定义资源已停用', `默认生成来源“${resource.label}”已停用；不会自动切换到其他来源。`);
  const safeResource = capabilities?.resources.find((candidate) => candidate.resourceId === resourceId);
  const details = `Provider ${safeResource?.apiType ?? resource.apiType} · 模型 ${safeResource?.defaultModel ?? resource.model ?? '未指定'}。`;
  if (safeResource && !safeResource.available) {
    return error(`自定义 · ${resource.label}不可用`, `${details}当前连接不可用；不会自动切换到其他来源。`);
  }
  return success(`自定义 · ${resource.label}`, details);
}

function optionalCapabilitySnapshot(
  response: LlmTaskStatusSnapshot | undefined,
  id: 'embedding' | 'rerank',
  label: '向量' | '重排',
): SettingsStatusSnapshot {
  if (!response) return warning('状态不可用', `暂时无法读取${label}服务状态。`);
  const resourceId = response.defaults[id];
  const resource = resourceId === undefined ? undefined : response.resources.find((item) => item.resourceId === resourceId);
  const capability = response.tasks.find((entry) => entry.execution === id);
  if (resource !== undefined) {
    if (resource.available) return success('可用', `${label} · ${resource.defaultModel ?? '默认模型'} 服务可用。`);
    return error('不可用', `${label}默认资源当前不可用；不会自动切换来源。`);
  }
  if (!capability) return neutral('未配置', `尚未配置${label}资源。`);
  if (capability.available) return success('可用', `${label}服务可用。`);
  if (capability.failure?.reasonCode === 'LLM_TASK_ROUTE_UNAVAILABLE') return neutral('未配置', `尚未配置${label}资源。`);
  if (capability.failure?.reasonCode === 'AUTH_FAILED') return error('缺少密钥', `${label}资源缺少密钥。`);
  return error('不可用', capability.failure?.reasonCode ? `${label}任务不可用（${capability.failure.reasonCode}）。` : `当前没有可用的${label}路由。`);
}

/** Event-driven settings status bridge. It never exposes credentials or provider response bodies. */
export class LlmSettingsStatusMonitor implements LlmSettingsStatusSource {
  private readonly listeners = new Set<(status: LlmSettingsStatusMap) => void>();
  private status: LlmSettingsStatusMap;
  private refreshGeneration = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private unsubscribeRepository: (() => void) | undefined;
  private unsubscribeHost: (() => void) | undefined;
  private unsubscribeCapability: (() => void) | undefined;

  constructor(
    private readonly session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'tavern.plugin.request' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write'>,
    private readonly repository: LlmWorkspaceRepository,
    private readonly handlers: LlmServiceHandlers,
    private readonly target: DiscoveryTarget = globalThis as unknown as DiscoveryTarget,
  ) {
    this.status = Object.freeze({
      tavernStatus: neutral('正在连接', '正在读取酒馆当前使用的来源和模型。'),
      generationSourceStatus: neutral('正在同步', '正在同步默认生成来源。'),
      generationStatus: neutral('正在同步', '正在同步生成路由状态。'),
      embeddingStatus: neutral('正在同步', '正在同步向量服务状态。'),
      rerankStatus: neutral('正在同步', '正在同步重排服务状态。'),
      about: this.versionSnapshot(),
    });
  }

  async start(): Promise<void> {
    this.unsubscribeRepository = this.repository.subscribeChanges(() => this.scheduleRefresh());
    try {
      this.unsubscribeHost = this.session.host.events.subscribe('generation-config-changed', () => this.scheduleRefresh());
    } catch {
      this.unsubscribeHost = undefined;
    }
    try {
      this.unsubscribeCapability = this.session.bus.subscribe(LLM_TASK_STATUS_CHANGED_V0, () => this.scheduleRefresh());
    } catch {
      this.unsubscribeCapability = undefined;
    }
    await this.refreshNow();
  }

  loadStatus(): LlmSettingsStatusMap { return this.status; }

  subscribeStatus(listener: (status: LlmSettingsStatusMap) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.refreshGeneration;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    const generationPort = this.session.host.generation as typeof this.session.host.generation & {
      readonly inspect?: () => Promise<{ readonly available?: boolean; readonly provider?: string; readonly model?: string }>;
    };
    const tavernPromise = (typeof generationPort.inspect === 'function'
      ? generationPort.inspect()
      : Promise.all([generationPort.available(), generationPort.current()]).then(([available, current]) => ({ ...current, available }))).then((current) => {
      if (current.available === false) return warning('未连接', '酒馆当前没有可用的生成连接。');
      const model = current.model?.trim();
      const provider = current.provider?.trim();
      if (!model && !provider) return warning('未选择模型', '酒馆连接可用，但尚未报告来源或模型。');
      return success(['酒馆', model ?? provider].join(' · '), '用于文本整理。');
    }).catch(() => warning('状态不可用', '无法读取酒馆当前连接状态。'));

    const capabilityPromise = this.handlers.taskStatus
      ? this.handlers.taskStatus({}, this.session.descriptor.id).catch(() => undefined)
      : Promise.resolve(undefined);
    let settingsFailure: unknown;
    const settingsPromise = this.repository.loadSettings().catch((failure) => { settingsFailure = failure; return undefined; });

    const [tavernStatus, capabilities, settings] = await Promise.all([tavernPromise, capabilityPromise, settingsPromise]);
    if (this.disposed || controller.signal.aborted || generation !== this.refreshGeneration) return;
    this.status = Object.freeze({
      tavernStatus,
      generationSourceStatus: settings === undefined
        ? error('设置不可用', settingsFailureDescription(settingsFailure))
        : generationSourceSnapshot(settings, tavernStatus, capabilities),
      generationStatus: generationSnapshot(capabilities),
      embeddingStatus: optionalCapabilitySnapshot(capabilities, 'embedding', '向量'),
      rerankStatus: optionalCapabilitySnapshot(capabilities, 'rerank', '重排'),
      about: this.versionSnapshot(),
    });
    for (const listener of this.listeners) {
      try { listener(this.status); } catch {
        // Settings observers are untrusted plugin UI callbacks. One broken
        // listener must not reject a background refresh or destabilise Core.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    this.controller?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.unsubscribeRepository?.();
    this.unsubscribeHost?.();
    this.unsubscribeCapability?.();
    this.listeners.clear();
  }

  private versionSnapshot(): SettingsStatusSnapshot {
    const core = this.target[CORE_DISCOVERY_SYMBOL]?.descriptor;
    const plugin = this.session.descriptor;
    return neutral([
      `LLM ${releaseVersion(plugin.pluginVersion)}`,
      `Core ${releaseVersion(core?.coreVersion)}`,
      `SDK ${releaseVersion(plugin.sdkPackageVersion)}`,
      `API ${plugin.apiVersion}`,
    ].join(' · '), `Core generation ${core?.generation ?? this.session.generation}`);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshNow().catch(() => undefined);
    }, 80);
  }
}
