import {
  CORE_DISCOVERY_SYMBOL,
  LLM_CAPABILITY_STATUS_CHANGED_V1,
  type CoreDiscoverySnapshot,
  type LlmCapabilityStatusResponse,
  type PluginSession,
  type SettingsStatusSnapshot,
} from '@ss-helper/sdk';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LlmServiceHandlers } from './services';

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

function serviceSnapshot(response: LlmCapabilityStatusResponse | undefined): SettingsStatusSnapshot {
  if (!response) return warning('状态不可用', 'LLM 实时状态暂不可用，请稍后重试。');
  const entries = new Map(response.checks.map((entry) => [entry.id, entry]));
  const generation = entries.get('generation');
  if (generation?.reason === 'llm_disabled') return neutral('已停用', 'LLM 已停用；其他插件不会发起 AI 请求。');
  if (!generation?.available) {
    const descriptions = {
      no_resource: '自定义 API 模式尚未配置可用的生成资源。',
      resource_disabled: '自定义生成资源已停用。',
      credential_missing: '自定义生成资源缺少密钥。',
      route_unavailable: '当前来源内没有满足请求能力的生成路由。',
      tavern_unavailable: '酒馆当前没有可用的来源和模型。',
      status_unavailable: '暂时无法读取所选生成来源的状态。',
    } as const;
    const source = generation?.source === 'tavern' ? '酒馆' : generation?.source === 'custom' ? '自定义 API' : undefined;
    return error(['生成不可用', source].filter(Boolean).join(' · '), descriptions[generation?.reason as keyof typeof descriptions] ?? '当前来源内没有可用的生成模型。');
  }
  const source = generation.source === 'tavern' ? '酒馆' : generation.source === 'custom' ? '自定义 API' : undefined;
  const generationDetails = [source, generation.resourceId, generation.model].filter((item, index, values) => Boolean(item) && values.indexOf(item) === index);
  const optional = [
    entries.get('embedding')?.available ? '向量化可用' : '向量化未配置',
    entries.get('rerank')?.available ? '重排序可用' : '重排序未配置',
  ];
  return success(['生成可用', ...generationDetails].join(' · '), optional.join(' · '));
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
    private readonly session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'core.ui.notification.v1'>,
    private readonly repository: LlmWorkspaceRepository,
    private readonly handlers: LlmServiceHandlers,
    private readonly target: DiscoveryTarget = globalThis as unknown as DiscoveryTarget,
  ) {
    this.status = Object.freeze({
      tavernStatus: neutral('正在连接', '正在读取酒馆当前使用的来源和模型。'),
      serviceStatus: neutral('正在同步', '正在同步 LLM 路由与资源状态。'),
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
      this.unsubscribeCapability = this.session.events.subscribe(LLM_CAPABILITY_STATUS_CHANGED_V1, () => this.scheduleRefresh());
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

    const tavernPromise = Promise.all([
      this.session.host.generation.available(),
      this.session.host.generation.current(),
    ]).then(([available, current]) => {
      if (!available) return warning('未连接', '酒馆当前没有可用的生成连接。');
      const model = current.model?.trim();
      const provider = current.provider?.trim();
      if (!model && !provider) return warning('未选择模型', '酒馆连接可用，但尚未报告来源或模型。');
      return success([provider, model].filter(Boolean).join(' · '), '用于文本整理。');
    }).catch(() => warning('状态不可用', '无法读取酒馆当前连接状态。'));

    const capabilityPromise = this.handlers.capabilityStatus
      ? this.handlers.capabilityStatus({ checks: [
        { id: 'generation', taskKey: 'settings_generation', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
        { id: 'embedding', taskKey: 'settings_embedding', taskKind: 'embedding', requiredCapabilities: ['embeddings'] },
        { id: 'rerank', taskKey: 'settings_rerank', taskKind: 'rerank', requiredCapabilities: ['rerank'] },
      ] }, controller.signal, this.session.descriptor.id).catch(() => undefined)
      : Promise.resolve(undefined);

    const [tavernStatus, capabilities] = await Promise.all([tavernPromise, capabilityPromise]);
    if (this.disposed || controller.signal.aborted || generation !== this.refreshGeneration) return;
    this.status = Object.freeze({
      tavernStatus,
      serviceStatus: serviceSnapshot(capabilities),
      about: this.versionSnapshot(),
    });
    for (const listener of this.listeners) listener(this.status);
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
      `API ${plugin.apiMajor}.${plugin.minApiMinor}`,
    ].join(' · '), `Core generation ${core?.generation ?? this.session.generation}`);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, 80);
  }
}
