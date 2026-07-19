import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { clampLogListWidth, presentDiagnostic, presentLogRow } from '../dist/src/ui/request-log-viewer.js';

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

test('request log viewer explains a legacy reason code when the error body is missing', () => {
  assert.deepEqual(presentDiagnostic('invalid_json', undefined), {
    code: 'invalid_json',
    message: '模型返回内容不是合法 JSON，无法解析。',
  });
  assert.deepEqual(presentDiagnostic('structured_output_truncated', undefined), {
    code: 'structured_output_truncated',
    message: '模型返回的结构化 JSON 在结束前被截断。',
  });
  assert.deepEqual(presentDiagnostic('future_error_code', undefined), {
    code: 'future_error_code',
    message: '日志只保存了错误码，未保存具体错误正文。',
  });
  assert.deepEqual(presentDiagnostic(undefined, undefined), {});
  assert.deepEqual(presentDiagnostic('invalid_json', '模型返回了截断内容'), {
    code: 'invalid_json',
    message: '模型返回了截断内容',
  });
});

test('request log viewer uses a toast for load status instead of an in-workspace status row', () => {
  assert.equal(viewerSource.includes('ss-helper-llm-log-status'), false);
  assert.equal(viewerStyles.includes('ss-helper-llm-log-status'), false);
  assert.match(viewerSource, /notify\('success', '日志已加载'/u);
  assert.match(viewerSource, /notify\('error', '日志加载失败'/u);
});
