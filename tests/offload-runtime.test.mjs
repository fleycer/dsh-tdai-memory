/**
 * Unit tests for offload-runtime.js — the pure message-shape helpers behind
 * the context-offload integration (vendor/tdai/offload).
 *
 * Two contracts are load-bearing:
 *  1. mapForOffload() must give upstream MUTABLE-FRIENDLY copies — upstream
 *     splices/pushes its work array; dsh's real session history must never
 *     be touched (the compaction subsystem is its sole owner).
 *  2. extractMmdText() must pull exactly the upstream-flagged
 *     `_mmdContextMessage` messages out of an assemble() result.
 *
 * Dependency-free: runs in a clean checkout.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildToolPairEvent,
  extractMmdText,
  extractText,
  mapBlocksForOffload,
  mapForOffload,
  safeJson,
  safeStringify,
} from '../offload-runtime.js';

test('extractText reads block arrays and string content', () => {
  assert.equal(extractText(' hi '), 'hi');
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(extractText([{ type: 'image', source: {} }]), '');
  assert.equal(extractText(undefined), '');
});

test('safeJson degrades to the raw string instead of throwing', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(safeJson('not json'), 'not json');
  assert.deepEqual(safeJson(undefined), {});
});

test('safeStringify never throws', () => {
  assert.equal(safeStringify({ a: 1 }), '{"a":1}');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(typeof safeStringify(cyclic), 'string');
});

test('mapBlocksForOffload passes known blocks through and wraps the rest', () => {
  const textBlock = { type: 'text', text: 'hello' };
  const toolUse = { type: 'tool_use', id: 't1', name: 'read', input: {} };
  const toolResult = { type: 'tool_result', tool_use_id: 't1', content: 'ok' };
  const out = mapBlocksForOffload([textBlock, toolUse, toolResult, { type: 'thinking', thinking: 'hmm' }]);
  assert.equal(out[0], textBlock, 'text blocks pass through untouched');
  assert.equal(out[1], toolUse, 'tool_use blocks pass through untouched');
  assert.equal(out[2], toolResult, 'tool_result blocks pass through untouched');
  assert.deepEqual(out[3], { type: 'text', text: '{"type":"thinking","thinking":"hmm"}' },
    'unknown blocks degrade to a text block, never disappear');
  assert.deepEqual(mapBlocksForOffload('plain'), [{ type: 'text', text: 'plain' }], 'string content becomes one text block');
  assert.deepEqual(mapBlocksForOffload(null), []);
});

test('mapForOffload produces fresh objects and copies never alias the input', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }], source: { callId: 'c1' } },
    { role: 'tool', content: 'result text', toolCallId: 'c1' },
    { role: 'assistant', content: 'plain string answer' },
  ];
  const out = mapForOffload(messages);

  assert.equal(out.length, 4);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(out[1].toolCallId, 'c1', 'tool call id comes from source.callId');
  assert.equal(out[2].toolCallId, 'c1', 'tool call id comes from ToolResultMessage.toolCallId');
  assert.equal(out[3].toolCallId, undefined, 'no call id, no key');

  // Contract 1: upstream mutates ITS array/objects — the input must not move.
  out[0].content.push({ type: 'text', text: 'injected' });
  out.splice(0, 1);
  assert.equal(messages.length, 4, 'input array untouched');
  assert.equal(messages[0].content.length, 1, 'input blocks untouched');

  assert.deepEqual(mapForOffload(undefined), [], 'null-safe');
});

test('extractMmdText pulls only the flagged MMD messages', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'noise' }] },
    { role: 'user', _mmdContextMessage: true, content: [{ type: 'text', text: 'graph A' }] },
    { role: 'user', _mmdContextMessage: true, content: [{ type: 'text', text: 'graph B' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'more noise' }] },
  ];
  assert.equal(extractMmdText(messages), 'graph A\n\ngraph B');
  assert.equal(extractMmdText([{ role: 'user', content: [{ type: 'text', text: 'no flag' }] }]), '');
  assert.equal(extractMmdText(undefined), '');
  assert.equal(
    extractMmdText([{ _mmdContextMessage: true, content: [{ type: 'image', source: {} }] }]),
    '', 'a flagged message without text contributes nothing');
});

test('buildToolPairEvent maps a tool/result event to the upstream pair shape', () => {
  const now = 1_000_000;
  const cached = { name: 'bash', params: { cmd: 'ls' }, at: now - 250 };
  const data = {
    message: { toolCallId: 'c7', content: [{ type: 'text', text: 'file.txt' }] },
    error: undefined,
  };
  assert.deepEqual(buildToolPairEvent({ cached, data, now }), {
    toolName: 'bash',
    toolCallId: 'c7',
    params: { cmd: 'ls' },
    result: 'file.txt',
    error: undefined,
    durationMs: 250,
  });
});

test('buildToolPairEvent degrades gracefully and classifies failures', () => {
  const now = 5;
  // No cached tool/call bookkeeping.
  const bare = buildToolPairEvent({
    cached: undefined,
    data: { message: { toolCallId: 'c8', content: 'text result' } },
    now,
  });
  assert.equal(bare.toolName, 'unknown_tool');
  assert.deepEqual(bare.params, {});
  assert.equal(bare.result, 'text result');
  assert.equal(bare.durationMs, undefined);

  // tool/result with is_error: the text is an error, not a result.
  const flagged = buildToolPairEvent({
    cached: { name: 'bash', params: {}, at: now },
    data: { message: { toolCallId: 'c9', content: 'boom', isError: true } },
    now,
  });
  assert.equal(flagged.result, undefined);
  assert.equal(flagged.error, 'boom');

  // Structured error field wins over message text.
  const structured = buildToolPairEvent({
    cached: undefined,
    data: {
      message: { content: '' },
      error: { name: 'TimeoutError', reason: 'tool timed out' },
    },
    now,
  });
  assert.equal(structured.error, 'tool timed out');
  assert.equal(structured.toolCallId, `auto-${now}`, 'missing call ids synthesize one');
});
