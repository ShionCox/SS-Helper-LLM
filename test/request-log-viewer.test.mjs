import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  clampLogListWidth,
  compactLogDetail,
  isRetryAttempt,
  presentAgentApiResponse,
  presentDiagnostic,
  presentLogResult,
  presentLogRow,
  presentWorkflowResults,
} from '../dist/src/ui/request-log-presentation.js';

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
  assert.equal(view.purpose, '用途未声明的生成任务');
  assert.equal(view.source, '_builtin_tavern_');
  assert.equal(view.model, '当前酒馆模型');
  assert.equal(view.latencyMs, 842);
  assert.equal(view.createdAt, 1_784_350_053_000);
  assert.equal(view.attempt, '未记录');
  assert.equal(view.usage, undefined);
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
  assert.match(viewerSource, /content: \{ json: normalized \}, mode: Mode\.tree/u);
  assert.equal(viewerSource.includes("action === 'format'"), false);
  assert.equal(viewerSource.includes('显示原文'), false);
  assert.match(viewerSource, /appendModeTag\(titleGroup, mode\)/u);
  assert.match(viewerSource, /titleGroup\.append\(title\)/u);
  assert.match(viewerSource, /top\.append\(titleGroup, time\)/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-item-status\[data-state="failed"\]/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-mode-tag\[data-mode="agent_shadow"\]/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-detail-pane > \.ss-helper-llm-json-editor[^}]+width: auto;[^}]+max-width: calc\(100% - 24px\)/u);
  assert.match(viewerStyles, /\.ss-helper-llm-json-editor \.jse-main[^}]+min-width: 0;[^}]+overflow: hidden/u);
});

test('request log viewer removes undefined values recursively from detail payloads', () => {
  assert.deepEqual(compactLogDetail({
    rerankQuery: undefined,
    nested: { rerankDocs: undefined, keep: 'value' },
    items: [undefined, { result: undefined, count: 2 }],
  }), {
    nested: { keep: 'value' },
    items: [{ count: 2 }],
  });
});

test('request log viewer groups Agent turns with accessible controls and SDK-owned actions', () => {
  assert.match(viewerSource, /agent_turn/u);
  assert.match(viewerSource, /workflowId/u);
  assert.match(viewerSource, /aria-expanded/u);
  assert.match(viewerSource, /aria-selected/u);
  assert.match(viewerSource, /role', 'tablist'/u);
  assert.match(viewerSource, /aria-controls/u);
  assert.match(viewerSource, /aria-labelledby/u);
  assert.match(viewerSource, /role', 'tabpanel'/u);
  assert.match(viewerSource, /ArrowLeft/u);
  assert.match(viewerSource, /ArrowRight/u);
  assert.match(viewerSource, /copyText/u);
  assert.match(viewerSource, /\.confirm\(/u);
  assert.equal(viewerSource.includes('navigator.clipboard'), false);
  assert.equal(viewerSource.includes('rerankQuery: undefined'), false);
  assert.match(viewerSource, /Agent Shadow/u);
  assert.match(viewerSource, /callScope/u);
  assert.match(viewerSource, /agent_workflow/u);
});

test('request log viewer exposes complete and incomplete responses, parsed memory and Agent final result with explicit status messages', () => {
  for (const label of ['发送信息', 'API 响应', '解析与校验', '返回结果', '未记录 API 返回内容', '未记录解析结果', '旧日志无法补回', '连接中断前已收到的不完整 API 响应', '它不代表模型的完整输出', '以下仅保留脱敏后的开头与结尾片段', '正文已省略；这条旧日志无法补回']) {
    assert.equal(viewerSource.includes(label), true, label);
  }
  assert.match(viewerSource, /rawResponseText: response\.rawResponseText/u);
  assert.match(viewerSource, /parsedResponse: response\.parsedResponse/u);
  assert.match(viewerSource, /normalizedResponse: response\.normalizedResponse/u);
  assert.match(viewerSource, /presentLogResult\(row\)/u);
  assert.match(viewerSource, /presentWorkflowResults\(group\.entries\)/u);
  assert.match(viewerSource, /校验未通过/u);
});

test('request result presentation distinguishes valid, invalid, tool, failed, unavailable and truncated states', () => {
  assert.deepEqual(presentLogResult({ response: { normalizedResponse: { value: 'ok' } } }), {
    status: 'validated', contentStatus: '结果已通过解析与校验。', content: { value: 'ok' },
  });
  const invalid = presentLogResult({
    state: 'failed', agent: { state: 'failed' },
    response: {
      parsedResponse: { value: 3 },
      validationIssues: [{ path: '$.value', keyword: 'type', expected: 'string' }],
      failure: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'llm.tools.turn.final_validate' },
    },
  });
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual(invalid.content, { value: 3 });
  assert.equal(invalid.diagnostic.code, 'SCHEMA_VALIDATION_FAILED');
  assert.equal(presentLogResult({ agent: { state: 'tool_calls' }, response: {} }).status, 'awaiting_tools');
  assert.equal(presentLogResult({ state: 'failed', response: { failure: { reasonCode: 'INVALID_JSON', stage: 'llm.parse' } } }).status, 'failed');
  const failedPreview = presentLogResult({
    state: 'failed',
    response: {
      responsePreview: { kind: 'truncated_text', prefix: '{"broken":', suffix: '}' },
      failure: { reasonCode: 'HTTP_RESPONSE_PROTOCOL_INVALID', stage: 'llm.bridge.http.response' },
    },
  });
  assert.equal(failedPreview.status, 'failed');
  assert.equal(failedPreview.content.prefix, '{"broken":');
  assert.equal(failedPreview.contentStatus.includes('开头与结尾片段'), true);
  const emptyFailure = presentLogResult({
    state: 'failed',
    response: {
      rawResponseText: '',
      failure: { reasonCode: 'STRUCTURED_OUTPUT_TRUNCATED', stage: 'llm.service.response' },
    },
  });
  assert.equal(emptyFailure.status, 'failed');
  assert.equal(Object.hasOwn(emptyFailure, 'content'), false);
  assert.equal(emptyFailure.contentStatus.includes('没有返回可展示的最终正文'), true);
  assert.equal(presentLogResult({ response: {} }).status, 'unavailable');
  assert.deepEqual(presentLogResult({ truncated: { paths: ['response.normalizedResponse'] }, response: {} }), {
    status: 'truncated', contentStatus: '结果因单条日志大小限制未保存，请查看截断信息。', omittedPaths: ['response.normalizedResponse'],
  });
});

test('request log rows expose only provider-reported token usage without inventing zeroes', () => {
  const reported = presentLogRow({
    response: { providerResponseMeta: { usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 } } },
  });
  assert.deepEqual(reported.usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  assert.equal(viewerSource.includes('API 未返回'), true);
  assert.equal(viewerSource.includes('Token ${view.usage?.totalTokens'), true);
});

test('Agent API response presentation exposes sanitized tool arguments and results when retained', () => {
  const summary = presentAgentApiResponse({
    entryKind: 'agent_turn',
    agent: {
      state: 'tool_calls', toolSessionRound: 1, totalCalls: 1,
      toolCalls: [{ callId: 'call-1', name: 'entity.resolve_context', argumentBytes: 42, arguments: { apiKey: '[已脱敏]', query: '待解析实体' } }],
      toolResults: [{ callId: 'call-1', name: 'entity.resolve_context', ok: true, resultBytes: 96, content: { secret: '[已脱敏]', items: ['结果一'] } }],
    },
    response: { providerResponseMeta: { outcome: 'success', finishReason: 'tool_calls' } },
  });
  assert.equal(summary.agent.state, 'tool_calls');
  assert.equal(summary.contentStatus.includes('尚非最终结果'), true);
  assert.deepEqual(summary.agent.toolCalls[0].arguments, { apiKey: '[已脱敏]', query: '待解析实体' });
  assert.deepEqual(summary.agent.toolResults[0].content, { secret: '[已脱敏]', items: ['结果一'] });
  assert.equal(summary.agent.toolCalls.some((call) => Object.hasOwn(call, 'callId')), false);
  assert.equal(summary.agent.toolResults.some((item) => Object.hasOwn(item, 'callId')), false);
  assert.equal(summary.contentStatus.includes('已保存的工具参数'), true);
});

test('request log viewer marks retries in rows and workflow groups', () => {
  assert.equal(isRetryAttempt({ attemptTag: '重试', attemptIndex: 1 }), true);
  assert.equal(isRetryAttempt({ attemptTag: '初次请求', attemptIndex: 2 }), true);
  assert.equal(isRetryAttempt({ attemptTag: '初次请求', attemptIndex: 1 }), false);
  assert.match(viewerSource, /appendRetryTag\(titleGroup, retry\)/u);
  assert.match(viewerSource, /appendRetryTag\(titleGroup, hasRetries\)/u);
  assert.match(viewerStyles, /\.ss-helper-llm-log-retry-tag/u);
});

test('workflow results keep the latest result per Stage and never mask a later invalid result', () => {
  const result = presentWorkflowResults([
    {
      startedAt: 1, taskKey: 'entities', workflow: { stageKey: 'entities', stageDescription: '实体解析' },
      agent: { state: 'final', toolSessionRound: 1 }, response: { normalizedResponse: { version: 'old-valid' } },
    },
    {
      startedAt: 2, state: 'failed', taskKey: 'entities', workflow: { stageKey: 'entities', stageDescription: '实体解析' },
      agent: { state: 'failed', toolSessionRound: 2 }, response: { parsedResponse: { version: 'latest-invalid' }, validationIssues: [{ path: '$.name', keyword: 'required', expected: 'present' }] },
    },
    {
      startedAt: 3, taskKey: 'inventory', workflow: { stageKey: 'inventory', stageDescription: '库存解析' },
      agent: { state: 'final', toolSessionRound: 1 }, response: { normalizedResponse: { items: [] } },
    },
  ]);
  assert.equal(result.status, 'invalid');
  assert.equal(result.stages.length, 2);
  assert.deepEqual(result.stages.find((stage) => stage.stageKey === 'entities').content, { version: 'latest-invalid' });
  assert.equal(JSON.stringify(result).includes('old-valid'), false);
});

test('request log viewer groups every traced request without persisting tool descriptions', () => {
  assert.match(viewerSource, /if \(!workflowId\) continue;/u);
  assert.equal(viewerSource.includes("!== 'agent_turn' || !workflowId"), false);
  assert.equal(viewerSource.includes('toolDescriptions'), false);
  assert.match(viewerSource, /filter\(row => row\.entryKind === 'agent_turn'\)\.length/u);
});
