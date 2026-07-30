import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { clampLogListWidth, presentDiagnostic, presentLogRow } from '../dist/src/ui/request-log-presentation.js';

const viewerSource = readFileSync(new URL('../src/ui/request-log-viewer.ts', import.meta.url), 'utf8');
const viewerStyles = readFileSync(new URL('../src/ui/request-log-viewer.css', import.meta.url), 'utf8');

test('request log viewer fills legacy summary fields without broken dash placeholders', () => {
  const view = presentLogRow({
    taskKey: 'memory_extract',
    state: 'failed',
    request: { taskKind: 'generation' },
    response: { meta: { resourceId: '_builtin_tavern_', model: '当前酒馆模型', latencyMs: 842 } },
    queuedAt: 1_784_350_053_000,
  });

  assert.equal(view.taskLabel, '生成');
  assert.equal(view.taskKey, 'memory_extract');
  assert.equal(view.source, '_builtin_tavern_');
  assert.equal(view.model, '当前酒馆模型');
  assert.equal(view.latencyMs, 842);
  assert.equal(view.createdAt, 1_784_350_053_000);
  assert.equal(view.attempt, '未记录');
});

test('request log viewer infers capability and uses readable unknown labels', () => {
  const embedding = presentLogRow({ taskKey: 'memory_embedding_rebuild', response: {} });
  const unknown = presentLogRow({ taskKey: 'memory_extract', response: {} });

  assert.equal(embedding.taskKind, 'embedding');
  assert.equal(embedding.taskLabel, '向量化');
  assert.equal(unknown.taskLabel, '生成');
  assert.equal(unknown.source, '来源未知');
  assert.equal(unknown.model, '');
  assert.equal(unknown.latencyMs, undefined);
});

test('request log viewer splitter keeps both panes usable', () => {
  assert.equal(clampLogListWidth(1200, 100), 240);
  assert.equal(clampLogListWidth(1200, 500), 500);
  assert.equal(clampLogListWidth(1200, 1000), 768);
  assert.equal(clampLogListWidth(650, 500), 240);
});

test('request log viewer only renders the central structured failure', () => {
  assert.deepEqual(presentDiagnostic({ reasonCode: 'INVALID_JSON', stage: 'llm.parse' }), {
    code: 'INVALID_JSON',
    message: '模型返回内容不是有效 JSON：模型输出无法解析为单一完整 JSON。 允许一次结构修复；持续失败时更换模型。',
  });
  assert.deepEqual(presentDiagnostic({ reasonCode: 'STRUCTURED_OUTPUT_TRUNCATED', stage: 'llm.parse' }), {
    code: 'STRUCTURED_OUTPUT_TRUNCATED',
    message: '模型结构化输出被截断：模型达到输出上限，JSON 没有完整结束。 减少批次内容或提高输出上限后重试。',
  });
  assert.deepEqual(presentDiagnostic({ reasonCode: 'future_error_code', stage: 'llm.parse' }), {});
  assert.deepEqual(presentDiagnostic(undefined), {});
});

test('request log viewer uses a toast for load status instead of an in-workspace status row', () => {
  assert.equal(viewerSource.includes('ss-helper-llm-log-status'), false);
  assert.equal(viewerStyles.includes('ss-helper-llm-log-status'), false);
  assert.match(viewerSource, /notify\('success', '日志已加载'/u);
  assert.match(viewerSource, /notify\('error', '日志加载失败'/u);
});

test('request log viewer uses JSONEditor and keeps status beside the title', () => {
  assert.match(viewerSource, /mount\(JSONEditor/u);
  assert.equal(viewerSource.includes("action === 'format'"), false);
  assert.equal(viewerSource.includes('显示原文'), false);
  assert.match(viewerSource, /titleGroup\.append\(statusIcon, title\)/u);
  assert.match(viewerSource, /top\.append\(titleGroup, time\)/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-item-status\[data-state="failed"\]/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-detail-pane > \.ss-helper-llm-json-editor[^}]+width: auto;[^}]+max-width: calc\(100% - 24px\)/u);
  assert.match(viewerStyles, /\.ss-helper-llm-json-editor \.jse-main[^}]+min-width: 0;[^}]+overflow: hidden/u);
});
