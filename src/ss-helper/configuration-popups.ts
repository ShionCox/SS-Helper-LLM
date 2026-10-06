import { describeSSHelperFailure, type PopupUiContext, type ToastNotification } from '@ss-helper/sdk';
import type { LLMHubSettings } from '../schema/types';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import { BUILTIN_TAVERN_RESOURCE_ID } from '../router/router.js';

/** These editors update only their own keys against the latest stored settings. */
export async function renderConfigurationPopup(
  container: HTMLElement, kind: 'default-routes' | 'budget-manager', repository: LlmWorkspaceRepository,
  ui: PopupUiContext, notify?: (notification: ToastNotification & { title: string; code: string }) => void,
): Promise<() => void> {
  const document = container.ownerDocument;
  let settings = await repository.loadSettings();
  const consumers = kind === 'budget-manager' ? await repository.loadConsumers() : {};
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '修改会即时保存。';
  const form = document.createElement('div');
  form.style.display = 'grid'; form.style.gap = '16px';
  container.append(form, status);
  let disposed = false;
  let queue = Promise.resolve();
  const pending = new Map<HTMLInputElement, ReturnType<typeof setTimeout>>();
  const save = (update: (current: LLMHubSettings) => LLMHubSettings, rollback: () => void): void => {
    status.textContent = '正在保存…';
    queue = queue.then(async () => {
      try {
        settings = await repository.updateSettings((current) => ({ ...update(current) }));
        if (!disposed) status.textContent = '已保存并生效。';
      } catch (error) {
        if (disposed) return;
        rollback();
        const failure = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'llm.settings.popup.save' });
        const message = `${failure.reasonCode} · ${failure.title}：${failure.reason} ${failure.action}${failure.requestId ? `（${failure.requestId}）` : ''}`;
        status.textContent = message;
        try { notify?.({ level: 'error', title: failure.title, message, code: failure.reasonCode }); } catch { /* A closing session must not break the save queue. */ }
      }
    });
  };
  const render = (): void => {
    form.replaceChildren();
    if (kind === 'default-routes') {
      const note = document.createElement('p'); note.textContent = '任务专属分配优先；未单独分配的任务使用这里的默认资源。'; form.append(note);
      for (const [type, label] of [['generation', '生成'], ['embedding', '向量'], ['rerank', '重排']] as const) {
        const current = settings.globalAssignments?.[type]?.resourceId ?? '';
        const options = [
          { value: '', label: type === 'generation' ? '酒馆当前连接（默认）' : '未配置默认资源' },
          ...(type === 'generation' ? [{ value: BUILTIN_TAVERN_RESOURCE_ID, label: '酒馆当前连接' }] : []),
          ...(settings.resources ?? []).filter((resource) => resource.type === type && resource.enabled !== false).map((resource) => ({ value: resource.id, label: `${resource.label} · ${resource.model}` })),
        ];
        if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: `当前资源不可用：${current}` });
        const row = document.createElement('div'); row.style.display = 'grid'; row.style.gap = '6px';
        const heading = document.createElement('span'); heading.textContent = `${label}默认资源`;
        row.append(heading, ui.createSelect({ label: heading.textContent, value: current, options, onChange: (value) => save((latest) => {
          const globalAssignments = { ...latest.globalAssignments };
          if (value) globalAssignments[type] = { resourceId: value }; else delete globalAssignments[type];
          return { ...latest, globalAssignments };
        }, render) }));
        form.append(row);
      }
      return;
    }
    const ids = [...new Set([...Object.keys(consumers), ...Object.keys(settings.budgets ?? {}), ...(settings.taskAssignments ?? []).map((task) => task.pluginId)])].sort();
    if (!ids.length) { const empty = document.createElement('p'); empty.textContent = '尚无调用方注册，无需填写额度。'; form.append(empty); }
    for (const id of ids) {
      const group = document.createElement('fieldset');
      group.style.display = 'grid'; group.style.gap = '12px'; group.style.minWidth = '0';
      const legend = document.createElement('legend');
      const consumer = consumers[id];
      const name = consumer && typeof consumer === 'object' && 'displayName' in consumer && typeof consumer.displayName === 'string' ? consumer.displayName : id;
      legend.textContent = name === id ? id : `${name}（${id}）`; group.append(legend);
      for (const [key, label, scale] of [['maxRPM', '每分钟请求数', 1], ['maxTokens', '单次 Token 上限', 1], ['maxLatencyMs', '最长等待（秒）', 1000]] as const) {
        const value = settings.budgets?.[id]?.[key];
        const input = ui.createInput({ label, type: 'number', value: value === undefined ? '' : String(value / scale), placeholder: '留空不限制' });
        input.min = String(1 / scale); input.step = String(1 / scale);
        const maximum = key === 'maxRPM' ? 60_000 : key === 'maxTokens' ? 1_000_000 : 600_000;
        input.max = String(maximum / scale);
        const flush = (): void => {
          const timer = pending.get(input); if (timer === undefined) return;
          clearTimeout(timer); pending.delete(input);
          const raw = input.value.trim(); const numeric = raw === '' ? undefined : Number(raw) * scale;
          if (numeric !== undefined && (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > maximum)) {
            const message = `请输入 ${input.min} 到 ${input.max} 之间的有效数值，或留空取消限制。`;
            input.setAttribute('aria-invalid', 'true'); status.textContent = message;
            notify?.({ level: 'warning', title: '额度尚未保存', message, code: 'LLM_BUDGET_INPUT_INVALID' }); return;
          }
          input.removeAttribute('aria-invalid');
          save((latest) => {
            const budgets = { ...latest.budgets }; const entry = { ...budgets[id] };
            if (numeric === undefined) delete entry[key]; else entry[key] = numeric;
            if (Object.keys(entry).length) budgets[id] = entry; else delete budgets[id];
            return { ...latest, budgets };
          }, () => { const saved = settings.budgets?.[id]?.[key]; input.value = saved === undefined ? '' : String(saved / scale); });
        };
        input.addEventListener('input', () => { clearTimeout(pending.get(input)); pending.set(input, setTimeout(flush, 350)); });
        input.addEventListener('blur', flush);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') flush(); });
        const row = document.createElement('label'); row.style.display = 'grid'; row.style.gap = '6px';
        const text = document.createElement('span'); text.textContent = label;
        row.append(text, input); group.append(row);
      }
      const clear = ui.createButton({ label: '清除该调用方限制', size: 'sm' });
      clear.addEventListener('click', () => {
        for (const input of Array.from(group.querySelectorAll('input'))) { clearTimeout(pending.get(input)); pending.delete(input); input.value = ''; }
        save((latest) => { const budgets = { ...latest.budgets }; delete budgets[id]; return { ...latest, budgets }; }, render);
      });
      group.append(clear); form.append(group);
    }
  };
  render();
  return () => { for (const input of pending.keys()) input.dispatchEvent(new document.defaultView!.Event('blur')); disposed = true; };
}
