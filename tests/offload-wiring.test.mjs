/**
 * Wiring contracts for the context-offload integration in index.js.
 *
 * The static half pins the integration seams to the vendored upstream module
 * (vendor/tdai/offload) — the ones that silently degrade if broken: the
 * context-engine slot gate, the scratch-copy rule (dsh's compaction subsystem
 * must remain the sole owner of session history), the L3-compression kill
 * switch, and the tool/call -> before_tool_call / tool/result ->
 * after_tool_call dispatch.
 *
 * The behavioural half validates the real schema and drives the assembly
 * listener through a minimal cordis-shaped ctx; it needs the plugin's runtime
 * dependencies and skips with a reason in a clean checkout (same pattern as
 * tools-registration.test.mjs).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
// Scan code only: doc comments legitimately name the wiring.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('offload wires the vendored upstream module, not a reimplementation', () => {
  assert.match(code, /import \{ registerOffload \} from "\.\/vendor\/tdai\/offload\/index\.js";/,
    'the vendored upstream offload module is the engine');
});

test('the offload config group exists and is off by default', () => {
  const group = code.slice(code.indexOf('offload: z.object({'));
  assert.notEqual(code.indexOf('offload: z.object({'), -1, 'schema must define the offload group');
  assert.match(group, /enabled: z\.boolean\(\)\.default\(false\)/,
    'offload ships disabled until the user opts in');
  for (const field of ['model', 'dataDir', 'temperature', 'contextWindow', 'mmdMaxTokenRatio', 'forceTriggerThreshold', 'maxPairsPerBatch']) {
    assert.match(group, new RegExp(`${field}:`), `offload.${field} must be configurable`);
  }
});

test('L3 history compression stays disabled — compaction is the host\'s', () => {
  const setup = code.slice(code.indexOf('function setupOffload('));
  assert.match(setup, /mildOffloadRatio: 99/, 'mild L3 compression must never trigger');
  assert.match(setup, /aggressiveCompressRatio: 99/, 'aggressive L3 compression must never trigger');
  // The scratch-copy rule: assemble() only ever sees mapped copies.
  assert.match(code, /messages: mapForOffload\(session\.deriveMessages\(\)\)/,
    'engine.assemble() must run on a mapped scratch copy, never on real history');
  assert.doesNotMatch(code, /\.splice\(0,/, 'index.js must never splice session history');
});

test('the upstream context-engine slot gate is satisfied', () => {
  // Upstream registerOffload is a no-op on every hook unless the context
  // engine slot is configured to the id it registers (CE_PLUGIN_ID).
  assert.match(code, /plugins: \{ slots: \{ contextEngine: "memory-tencentdb" \} \}/,
    'a missing slot gate makes every offload hook silently no-op upstream');
});

test('tool events dispatch to the upstream hook contract', () => {
  assert.match(code, /offloadDispatch\("before_tool_call", \{\s*toolCallId: event\.data\.callId,\s*params: safeJson\(event\.data\.arguments\),/,
    'tool/call must dispatch before_tool_call with {toolCallId, params}');
  assert.match(code, /offloadDispatch\("after_tool_call", \{/,
    'tool/result must dispatch after_tool_call');
  assert.match(code, /\.\.\.buildToolPairEvent\(\{\s*cached:/,
    'the after_tool_call pair is built from the cached tool/call bookkeeping');
});

test('offload lifecycle hooks are wired (bootstrap + one-shot afterTurn)', () => {
  assert.match(code, /engine0\.bootstrap\(\{ sessionKey: session\.id, sessionId: session\.id \}\)/,
    'per-session state managers must be warmed on session/created');
  assert.match(code, /afterTurn\?\.\(\{ sessionKey: session\.id, sessionId: session\.id \}\)/,
    'one-shot runs must flush the last offload turn before exit');
});

test('MMD injection appends a tdai:mmd context after recall entries', () => {
  assert.match(code, /name: "tdai:mmd", order: 1002/,
    'MMD is delivered as a prompt context ordered after tdai:recall(1000)/tdai:profile(1001)');
  assert.match(code, /contexts: \[\.\.\.\(result\.contexts \?\? \[\]\), \{ name: "tdai:mmd"/,
    'contexts must be appended, never replaced');
  assert.match(code, /extractMmdText\(result\?\.messages\)/,
    'only the upstream-flagged _mmdContextMessage is extracted');
});

test('incomplete LLM settings disable offload loudly instead of half-working', () => {
  assert.match(code, /offload enabled but llm\.baseUrl\/llm\.apiKey\/llm\.model incomplete/,
    'upstream needs all three; a silent half-wired runtime was the failure mode to avoid');
});

// ── behavioural half (needs the plugin's runtime dependencies) ──────────────
let plugin = null;
let importError = null;
try {
  plugin = await import('../index.js');
} catch (error) {
  importError = error;
}

const behaviorTest = importError ? test.skip : test;
if (importError) {
  console.log(`# offload-wiring behavioural tests skipped: ${importError.code ?? importError.message}`);
}

behaviorTest('the real schema validates the offload defaults', () => {
  const offload = plugin.Config['~standard'].validate({}).value.get().offload;
  assert.deepEqual(offload, {
    enabled: false,
    model: '',
    dataDir: '',
    temperature: 0.2,
    contextWindow: 200000,
    mmdMaxTokenRatio: 0.2,
    forceTriggerThreshold: 4,
    maxPairsPerBatch: 20,
  });
  const custom = plugin.Config['~standard'].validate({
    offload: { enabled: true, model: 'prov/model-x', contextWindow: 128000 },
  }).value.get().offload;
  assert.equal(custom.enabled, true);
  assert.equal(custom.model, 'prov/model-x');
  assert.equal(custom.contextWindow, 128000);
});

/** Minimal cordis-shaped ctx: only what apply() touches before a turn runs. */
function makeCtx() {
  const handlers = new Map();
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    handlers,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    effect() {},
    inject() {},
    get(name) {
      return name === 'agents' ? agents : undefined;
    },
  };
}

const agents = new Map();

behaviorTest('the assembly listener attaches and passes assembly through untouched when offload is idle', async () => {
  const ctx = makeCtx();
  // Drop the timers apply() schedules (the 500ms fallback build must NOT
  // construct TdaiCore). The attach timer is scheduled later — at emit time,
  // on the real setTimeout — so it still fires.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    plugin.apply(ctx, plugin.Config['~standard'].validate({}).value);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  const session = {
    id: 'sess-1',
    deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  };
  const agentHandlers = new Map();
  agents.set(session.id, {
    ctx: {
      on(event, handler) {
        agentHandlers.set(event, [...(agentHandlers.get(event) ?? []), handler]);
      },
    },
  });

  ctx.emit('session/created', session);
  // The session/created handler defers its agent lookup one tick.
  await new Promise((resolve) => realSetTimeout(resolve, 10));

  const [assemble] = agentHandlers.get('system-prompt/assemble') ?? [];
  assert.ok(assemble, 'the assembly listener must attach to the agent scope');

  const assembly = { contexts: [] };
  const result = await assemble(assembly, {});
  assert.deepEqual(result, assembly,
    'with no recall cache and no offload runtime the assembly must pass through unchanged');
  assert.equal(result, assembly, 'passthrough must return the same object');
});
