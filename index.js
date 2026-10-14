/**
 * dsh-tdai-memory — TencentDB Agent Memory ported into DeepSeek Harness.
 *
 * Reuses the host-neutral core of `tdai-memory-openclaw-plugin`
 * (TdaiCore: L0 conversation capture -> L1 structured facts -> L2 scenes ->
 * L3 persona; vector recall; memory/conversation search) through a thin
 * DshHostAdapter. The existing data directory (~/.memory-tencentdb/memory-tdai)
 * is reused as-is, so previously accumulated memories stay available.
 *
 * Wiring:
 *  - `session/event` (turn/start, turn/end) -> L0 capture + pipeline trigger
 *  - `system-prompt/assemble` waterfall -> per-turn recall injection
 *    (relevant L1 memories + L3 persona + L2 scene navigation)
 *  - tools `tdai_memory_search` / `tdai_conversation_search`
 *  - LLM calls (L1/L2/L3 extraction) go through the standalone OpenAI-
 *    compatible runner (config `llm`, falls back to TDAI_LLM_* env vars)
 *  - embeddings through the configurable OpenAI-compatible endpoint
 *    (defaults to the local Qwen3-Embedding-0.6B service on :8088)
 */
import os from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TdaiCore } from "./vendor/tdai/core/tdai-core.js";
import { parseConfig } from "./vendor/tdai/config.js";
import { StandaloneHostAdapter } from "./vendor/tdai/adapters/standalone/host-adapter.js";
import { registerOffload } from "./vendor/tdai/offload/index.js";
import { createRecallCache, recallWithTimeout } from "./recall-runtime.js";
import {
  buildToolPairEvent,
  extractMmdText,
  extractText,
  mapForOffload,
  safeJson,
  safeStringify,
} from "./offload-runtime.js";

/** Cordis plugin name. */
const name = "tdai-memory";
/** Services this row injects. */
const inject = ["sessions", "systemPrompt", "tools"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = "tdai-memory";

/** Runtime schema for the tdai-memory row. */
const Config = z.object({
  /** TDAI data directory; default: ~/.memory-tencentdb/memory-tdai. */
  dataDir: z.string().default(""),
  /** LLM used for L1/L2/L3 extraction (OpenAI-compatible). Falls back to TDAI_LLM_* env. */
  llm: z.object({
    baseUrl: z.string().default(""),
    apiKey: z.string().default("").role("secret"),
    model: z.string().default(""),
    maxTokens: z.number().default(4096),
    timeoutMs: z.number().default(120000),
    /** Send a stable session-id header on LLM requests. OpenCode Go and other
     *  gateways require `x-opencode-session` on every request; missing it may
     *  error after 2026-09-06. Value: `sessionId` below, else a persistent
     *  per-instance random id stored under the data dir. */
    sendSessionHeader: z.boolean().default(true),
    /** Header name carrying the session id. */
    sessionHeaderName: z.string().default("x-opencode-session"),
    /** Fixed session id for LLM requests; empty = persistent auto id. */
    sessionId: z.string().default(""),
  }).default({}),
  /** Embedding endpoint (OpenAI-compatible /v1/embeddings). */
  embedding: z.object({
    baseUrl: z.string().default("http://127.0.0.1:8088/v1"),
    apiKey: z.string().default("").role("secret"),
    model: z.string().default("Qwen3-Embedding-0.6B"),
    dimensions: z.number().default(1024),
    sendDimensions: z.boolean().default(false),
  }).default({}),
  /** Capture conversations into L0. */
  captureEnabled: z.boolean().default(true),
  /** L1 extraction pipeline (facts from conversations). */
  extraction: z.object({
    enabled: z.boolean().default(true),
    /** Conflict detection before storing; extra LLM call, disable if flaky.
     *  Off by default: dedup LLM output parsing is flaky (README matches). */
    enableDedup: z.boolean().default(false),
  }).default({}),
  /** Recall injection settings. */
  recall: z.object({
    enabled: z.boolean().default(true),
    maxResults: z.number().default(5),
    scoreThreshold: z.number().default(0.3),
    timeoutMs: z.number().default(3000),
  }).default({}),
  /** Context offload (upstream `src/offload`): tool-pair offload + L1.5 task
   *  judgment + Mermaid short-term memory (MMD) injected as prompt context.
   *  Consumes LLM calls on its own endpoint, so it is off by default. */
  offload: z.object({
    enabled: z.boolean().default(false),
    /** Model for offload's own LLM calls, "provider/model-id". The provider
     *  part is a label; the endpoint always comes from llm.baseUrl/llm.apiKey.
     *  Empty = llm.model. Model ids must not contain "/". */
    model: z.string().default(""),
    /** Offload data dir; default: ~/.memory-tencentdb/context-offload. */
    dataDir: z.string().default(""),
    temperature: z.number().default(0.2),
    /** Assumed context window in tokens (MMD budget base). */
    contextWindow: z.number().default(200000),
    /** Max share of the context window the injected MMD may occupy. */
    mmdMaxTokenRatio: z.number().default(0.2),
    /** Tool pairs pending in a session that force an L1 extraction flush. */
    forceTriggerThreshold: z.number().default(4),
    maxPairsPerBatch: z.number().default(20),
  }).default({}),
  /** Register the two search tools. */
  toolsEnabled: z.boolean().default(true),
}).volatile();

/**
 * Whether a derived message is real human input.
 *
 * A `"user"` role alone is not enough: DSH injects synthetic user-role
 * context (system reminders, runtime context, skill catalogs, goal rounds,
 * tool results, …) that must never be treated as user input. Real input is
 * distinguished by `message.source.kind === "user"` (see dsh-llm Message
 * types). Messages without a `source` (older harnesses) are treated as real
 * input to stay compatible.
 */
function isRealUserMessage(m) {
  return m?.role === "user" && (m.source == null || m.source.kind === "user");
}

// Message-shape helpers for the offload integration (extractText, safeJson,
// safeStringify, mapForOffload, extractMmdText, buildToolPairEvent) live in
// offload-runtime.js — pure and unit-tested in tests/offload-runtime.test.mjs.

/**
 * Resolve the config value handed to `apply`.
 *
 * The row schema ends in `.volatile()` (hot-reloadable config). Config
 * validation runs through the standard-schema path, which returns the
 * validated object wrapped in a cosmokit `Volatile`: a frozen `{ get() }`
 * reference whose OWN properties are always `undefined`. Reading
 * `config.toolsEnabled` off it can therefore never be true — the tools guard
 * did exactly that and silently stopped registering the search tools in
 * v0.3.4 (issue #3). Read config through this helper only.
 *
 * The wrapper is a live reference (`updateVolatile` swaps its inner value), so
 * calling this at use time — not once at startup — sees volatile edits.
 */
function runtimeConfigOf(config) {
  return typeof config?.get === "function" ? config.get() : config;
}

function apply(ctx, config) {
  // ── build-once state (rebuildable) ───────────────────────────────────────
  // TdaiCore is built once from the resolved row config: the composition entry
  // as base with the Plugins-page values merged in by the host (settings.yaml is
  // no longer a config source since v0.4.0 — see client.js `configForms`). The
  // build is deferred past the 0ms window so web/headless boots are never
  // blocked on TdaiCore's stores and embedding client.
  let core = null;
  let tdaiConfig = null;
  let dataDir = "";
  let builtOnce = false;

  /** turn id of the last turn/end per session (capture trigger). */
  const lastTurnEnd = new Map();
  /** turn ids already captured per session (dedup across flushes). */
  const capturedTurns = new Map();
  /** turn/start timestamp per session (L0 capture cursor floor). */
  const turnStarts = new Map();
  /** session keys seen this process (for final L1 flush on teardown). */
  const seenSessions = new Set();
  /** Bound the per-session bookkeeping in long-lived (web) hosts: Map/Set
   *  insertion order makes the oldest session the first to evict. */
  const MAX_TRACKED_SESSIONS = 256;
  function trim(tracked) {
    while (tracked.size > MAX_TRACKED_SESSIONS) tracked.delete(tracked.keys().next().value);
  }
  /** recall cache per session: same user text within TTL reuses the result. */
  const recallCache = createRecallCache();

  // ── context-offload runtime (rebuildable with the core) ──────────────────
  // `offloadRuntime` is set by build() when `offload.enabled`; every consumer
  // reads it at call time so a disabled or half-built runtime degrades to a
  // no-op. `hooks` maps upstream hook names (before_tool_call, after_tool_call,
  // …) to the handlers registerOffload() produced; `engine` is the
  // OffloadContextEngine captured from registerContextEngine().
  let offloadRuntime = null;
  /** in-flight tool calls per session (name/params/timing for tool/result). */
  const offloadToolCalls = new Map();
  /** Call one upstream offload hook. Errors never propagate into dsh. */
  function offloadDispatch(hookName, event, session) {
    const rt = offloadRuntime;
    const handler = rt?.hooks?.get(hookName);
    if (!handler) return;
    void (async () => {
      try {
        await handler(event, { sessionKey: session.id, sessionId: session.id });
      } catch (error) {
        ctx.logger.warn(`[tdai-memory] offload ${hookName} failed: ${String(error)}`);
      }
    })();
  }

  // One-shot mode (dsh --profile headless): the process exits right after
  // flush, so L1 must finish inside the flush listener. In web mode the
  // long-lived process runs the pipeline in the background instead.
  const isOneShot = process.argv.some((arg) => arg === "headless");

  // Verbose tdai-internal logging goes to the console only when explicitly
  // enabled; routine diagnostics use the dsh logger.
  const verbose = !!process.env.DSH_TDAI_DEBUG;
  const log = (level, m) => {
    if (verbose) console.error(`[tdai-memory] ${m}`);
    else if (level === "warn") ctx.logger.warn(`[tdai-memory] ${m}`);
    else if (level === "error") ctx.logger.error(`[tdai-memory] ${m}`);
  };
  const logger = {
    debug: (m) => log("debug", m),
    info: (m) => log("info", m),
    warn: (m) => log("warn", m),
    error: (m) => log("error", m),
  };

  // ── core construction (rebuildable) ──────────────────────────────────────
  async function build(cfg) {
    if (cfg?.llm?.apiKey) {
      log("debug", "build: using settings config (apiKey=<set>)");
    }
    // Tear down the previous core, if any (first build has none).
    const previous = core;
    if (previous) {
      await previous.destroy().catch((error) => {
        log("warn", `previous core destroy failed: ${String(error)}`);
      });
    }
    dataDir = cfg.dataDir || join(os.homedir(), ".memory-tencentdb", "memory-tdai");
    // No silent-broken extraction: a missing model must disable L1 explicitly
    // (parseConfig would otherwise fall back to its own placeholder model and
    // every extraction call would fail against the configured endpoint).
    const llmModel = cfg.llm.model || process.env.TDAI_LLM_MODEL || "";
    const extractionEnabled = cfg.extraction.enabled && !!llmModel;
    if (cfg.extraction.enabled && !llmModel) {
      log("warn", "no extraction model configured (llm.model / TDAI_LLM_MODEL); L1 extraction stays disabled — capture and search still work");
    }
    const nextConfig = parseConfig({
      timezone: "system",
      storeBackend: "sqlite",
      capture: { enabled: cfg.captureEnabled },
      extraction: { enabled: extractionEnabled, enableDedup: cfg.extraction.enableDedup },
      recall: { ...cfg.recall },
      embedding: {
        enabled: true,
        provider: "openai",
        baseUrl: cfg.embedding.baseUrl,
        apiKey: cfg.embedding.apiKey,
        model: cfg.embedding.model,
        dimensions: cfg.embedding.dimensions,
        sendDimensions: cfg.embedding.sendDimensions,
        timeoutMs: 10000,
      },
      llm: {
        enabled: true,
        baseUrl: cfg.llm.baseUrl || process.env.TDAI_LLM_BASE_URL || "",
        apiKey: cfg.llm.apiKey || process.env.TDAI_LLM_API_KEY || "",
        model: llmModel,
        maxTokens: cfg.llm.maxTokens,
        timeoutMs: cfg.llm.timeoutMs,
        sendSessionHeader: cfg.llm.sendSessionHeader,
        sessionHeaderName: cfg.llm.sessionHeaderName,
        sessionId: cfg.llm.sessionId,
      },
    });
    const nextHostAdapter = new StandaloneHostAdapter({
      dataDir,
      llmConfig: {
        baseUrl: nextConfig.llm.baseUrl,
        apiKey: nextConfig.llm.apiKey,
        model: nextConfig.llm.model,
        maxTokens: nextConfig.llm.maxTokens,
        timeoutMs: nextConfig.llm.timeoutMs,
        sendSessionHeader: nextConfig.llm.sendSessionHeader,
        sessionHeaderName: nextConfig.llm.sessionHeaderName,
        sessionId: nextConfig.llm.sessionId,
        dataDir,
      },
      logger,
      defaultUserId: "dsh-user",
      platform: "dsh",
    });
    const nextCore = new TdaiCore({ hostAdapter: nextHostAdapter, config: nextConfig, instanceId: "dsh" });
    // Publish before initialize so concurrent flush listeners already use the
    // new core; initialize() only sets up stores/pipeline.
    tdaiConfig = nextConfig;
    core = nextCore;
    recallCache.clear();
    await nextCore.initialize();
    // Context offload is rebuilt together with the core; a disabled or
    // misconfigured runtime just leaves offloadRuntime null (all no-ops).
    if (cfg.offload?.enabled) {
      setupOffload(cfg, nextConfig);
    } else {
      offloadRuntime = null;
    }
    const key = nextConfig.llm.apiKey || "";
    log("info", `initialized (dataDir=${dataDir}, llm=${nextConfig.llm.model}, apiKey=${key ? "<set>" : "<empty>"}, embedding=${nextConfig.embedding.model})`);
  }

  // ── context offload (Mermaid short-term memory) ───────────────────────────
  // Wires upstream `src/offload` (vendor/tdai/offload) into dsh: tool/call +
  // tool/result session events feed its tool-pair state, and its MMD
  // (Mermaid-canvas short-term memory) is assembled on a scratch copy of the
  // message history and delivered as a prompt context — dsh's own compaction
  // subsystem stays the sole owner of real session history. See VENDOR.md.
  function setupOffload(cfg, nextConfig) {
    offloadRuntime = null;
    const modelRef = cfg.offload.model || nextConfig.llm.model;
    const slash = modelRef.indexOf("/");
    const providerKey = slash > 0 ? modelRef.slice(0, slash) : "tdai-llm";
    const modelId = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
    const baseUrl = nextConfig.llm.baseUrl;
    const apiKey = nextConfig.llm.apiKey;
    if (!modelId || !baseUrl || !apiKey) {
      log("warn", "offload enabled but llm.baseUrl/llm.apiKey/llm.model incomplete (upstream needs all three); offload stays disabled");
      return;
    }
    const dataDir = cfg.offload.dataDir || join(os.homedir(), ".memory-tencentdb", "context-offload");
    const hooks = new Map();
    let engine = null;
    const contextWindow = cfg.offload.contextWindow;
    registerOffload({
      logger,
      registrationMode: "dsh-shim",
      config: {
        agents: { defaults: { model: `${providerKey}/${modelId}` } },
        models: {
          providers: {
            [providerKey]: {
              baseUrl,
              apiKey,
              models: [{ id: modelId, contextWindow }],
            },
          },
        },
        // Upstream offload only activates when its context-engine slot is
        // configured to the id it registers (CE_PLUGIN_ID = "memory-tencentdb");
        // anything else makes every offload hook a no-op upstream.
        plugins: { slots: { contextEngine: "memory-tencentdb" } },
      },
      on: (hookName, handler) => {
        // Last registration wins: registerOffload may run again on rebuild.
        hooks.set(hookName, handler);
      },
      registerContextEngine: (_id, factoryOrInstance) => {
        try {
          engine = typeof factoryOrInstance === "function" ? factoryOrInstance() : factoryOrInstance;
          return { ok: true };
        } catch (error) {
          log("warn", `offload context engine factory failed: ${String(error)}`);
          return { ok: false, error: String(error) };
        }
      },
    }, {
      enabled: true,
      mode: "local",
      model: `${providerKey}/${modelId}`,
      dataDir,
      userId: "dsh-user",
      temperature: cfg.offload.temperature,
      forceTriggerThreshold: cfg.offload.forceTriggerThreshold,
      defaultContextWindow: contextWindow,
      maxPairsPerBatch: cfg.offload.maxPairsPerBatch,
      mmdMaxTokenRatio: cfg.offload.mmdMaxTokenRatio,
      // L3 history compression is off on purpose: dsh's compaction subsystem
      // owns session history, and offload L3 would rewrite a scratch copy
      // whose compressed form is discarded. Ratios above 1 never trigger.
      mildOffloadRatio: 99,
      aggressiveCompressRatio: 99,
      backendTimeoutMs: nextConfig.llm.timeoutMs,
    });
    offloadRuntime = { engine, hooks, contextWindow };
    log("info", `offload registered (model=${providerKey}/${modelId}, dataDir=${dataDir}, engine=${engine ? "captured" : "MISSING"})`);
  }

  // ── capture: triggered on session/flush (awaitable; runs before process
  //    exit in headless, and at every request boundary in web) ─────────────
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") {
      turnStarts.set(session.id, event.time);
      trim(turnStarts);
    } else if (event.type === "turn/end") {
      lastTurnEnd.set(session.id, event.data.turn);
      trim(lastTurnEnd);
    } else if (event.type === "tool/call") {
      // Feed upstream offload's before_tool_call hook (param cache for the
      // tool pair recorded on tool/result).
      offloadToolCalls.set(`${session.id}\u0000${event.data.callId}`, {
        name: event.data.name,
        params: safeJson(event.data.arguments),
        at: Date.now(),
      });
      trim(offloadToolCalls);
      offloadDispatch("before_tool_call", {
        toolCallId: event.data.callId,
        params: safeJson(event.data.arguments),
      }, session);
    } else if (event.type === "tool/result") {
      // Name/params come from the matching tool/call bookkeeping when still
      // cached (buildToolPairEvent degrades gracefully without it).
      const message = event.data?.message ?? {};
      const callId = message.toolCallId ?? message.source?.callId;
      offloadDispatch("after_tool_call", {
        ...buildToolPairEvent({
          cached: callId ? offloadToolCalls.get(`${session.id}\u0000${callId}`) : undefined,
          data: event.data,
        }),
        messages: mapForOffload(session.deriveMessages()),
      }, session);
    }
  });

  ctx.on("session/flush", async (session) => {
    try {
      const turnId = lastTurnEnd.get(session.id);
      if (turnId === undefined || capturedTurns.get(session.id) === turnId) return;
      capturedTurns.set(session.id, turnId);
      trim(capturedTurns);
      seenSessions.add(session.id);
      trim(seenSessions);
      const startedAt = turnStarts.get(session.id) ?? Date.now();
      await captureTurn(session, startedAt);
      if (isOneShot) {
        // Run pending L1 extraction to completion before the process exits.
        await core?.handleSessionEnd(session.id).catch((error) => {
          ctx.logger.warn(`[tdai-memory] L1 flush failed: ${String(error)}`);
        });
        // Offload's own end-of-turn flush (upstream afterTurn flushes
        // fire-and-forget, so one-shot runs may lose its last L1 batch).
        await offloadRuntime?.engine?.afterTurn?.({ sessionKey: session.id, sessionId: session.id })?.catch?.(() => {});
      }
    } catch (error) {
      ctx.logger.warn(`[tdai-memory] capture failed: ${String(error)}`);
    }
  });

  async function captureTurn(session, startedAt) {
    if (!tdaiConfig?.capture.enabled) return;
    const derived = session.deriveMessages();
    // Start from the last REAL user message. DSH injects synthetic user-role
    // context (system reminders, runtime context, skill catalogs, goal
    // rounds, …) whose `source.kind` is not "user"; those must not pollute
    // L0 memory (issue #1).
    const lastUserIdx = derived.findLastIndex(isRealUserMessage);
    if (lastUserIdx < 0) return;
    const messages = derived
      .slice(lastUserIdx)
      .map((m) => {
        // Keep assistant replies and real user input only; drop synthetic
        // user-role messages (plugin context, tool results, …) injected
        // after the last real user message.
        if (m.role !== "assistant" && !isRealUserMessage(m)) return null;
        const text = extractText(m.content);
        if (!text) return null;
        return {
          id: m.id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role: m.role === "assistant" ? "assistant" : "user",
          content: text,
          timestamp: m.timestamp ?? startedAt ?? Date.now(),
        };
      })
      .filter(Boolean);
    if (messages.length === 0) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const result = await core.handleTurnCommitted({
      userText: lastUser?.content ?? "",
      assistantText: "",
      messages,
      sessionKey: session.id,
      startedAt,
    });
    ctx.logger.debug(`[tdai-memory] captured turn: l0=${result.l0RecordedCount} notified=${result.schedulerNotified} vectors=${result.l0VectorsWritten}`);
  }

  // ── recall injection ────────────────────────────────────────────────────
  // The prompt assembly runs inside the agent's own context (scope = agent),
  // so the waterfall listener must be registered on `agent.ctx` — root-level
  // listeners never see agent-scoped assemblies. Agents appear right after
  // their session is announced, so defer one tick and attach there.
  ctx.on("session/created", (session) => {
    // Warm the offload per-session state manager (resolves + attaches it for
    // the later hook calls and engine.assemble()).
    const engine0 = offloadRuntime?.engine;
    if (engine0?.bootstrap) {
      void Promise.resolve(engine0.bootstrap({ sessionKey: session.id, sessionId: session.id })).catch((error) => {
        ctx.logger.warn(`[tdai-memory] offload bootstrap failed: ${String(error)}`);
      });
    }
    setTimeout(() => {
      try {
        const agents = ctx.get("agents");
        const agent = agents?.get?.(session.id);
        if (!agent?.ctx) return;
        agent.ctx.on("system-prompt/assemble", async (assembly, context) => {
          try {
            const lastUser = [...session.deriveMessages()].reverse().find(isRealUserMessage);
            const text = lastUser ? extractText(lastUser.content) : "";
            let result = assembly;

            // ── long-term recall (tdai:recall / tdai:profile contexts) ──────
            if (tdaiConfig?.recall.enabled && text) {
              try {
                const cached = recallCache.get(session.id, text);
                let recallResult = cached;
                if (cached === undefined) {
                  const recallCore = core;
                  recallResult = await recallWithTimeout(
                    () => recallCore.handleBeforeRecall(text, session.id), tdaiConfig.recall.timeoutMs + 1000,
                  );
                  if (core === recallCore) recallCache.set(session.id, text, recallResult);
                }
                result = injectRecall(result, recallResult ?? {});
              } catch (error) {
                ctx.logger.warn(`[tdai-memory] recall failed: ${String(error)}`);
              }
            }

            // ── context offload MMD (tdai:mmd context) ─────────────────────
            // Assembled on a scratch copy of the history — dsh's compaction
            // subsystem stays the sole owner of real session history.
            const mmdText = await offloadMmdContext(session, text);
            if (mmdText) {
              result = {
                ...result,
                contexts: [...(result.contexts ?? []), { name: "tdai:mmd", order: 1002, text: mmdText }],
              };
            }
            return result;
          } catch (error) {
            ctx.logger.warn(`[tdai-memory] recall failed: ${String(error)}`);
            return assembly;
          }
        });
      } catch (error) {
        ctx.logger.warn(`[tdai-memory] recall attach failed: ${String(error)}`);
      }
    }, 0);
  });

  function injectRecall(assembly, result) {
    const extras = [];
    if (result.prependContext) extras.push({ name: "tdai:recall", order: 1000, text: result.prependContext });
    if (result.appendSystemContext) extras.push({ name: "tdai:profile", order: 1001, text: result.appendSystemContext });
    if (extras.length === 0) return assembly;
    return { ...assembly, contexts: [...(assembly.contexts ?? []), ...extras] };
  }

  /**
   * Assemble upstream context-offload MMD (Mermaid short-term memory) on a
   * SCRATCH copy of the message history and return it as prompt text (null
   * when nothing to inject / offload disabled). The output messages carry
   * the injected MMD message flagged `m._mmdContextMessage`; dsh's real
   * history is never mutated. Calling assemble() per prompt assembly is also
   * what settles upstream's L1.5 stage for hosts without a context-engine
   * lifecycle (upstream note in offload/index.ts).
   */
  async function offloadMmdContext(session, prompt) {
    const rt = offloadRuntime;
    const engine = rt?.engine;
    if (!engine?.assemble || !prompt) return null;
    try {
      const result = await engine.assemble({
        messages: mapForOffload(session.deriveMessages()),
        tokenBudget: rt.contextWindow,
        prompt,
        sessionKey: session.id,
        sessionId: session.id,
      });
      return extractMmdText(result?.messages) || null;
    } catch (error) {
      ctx.logger.warn(`[tdai-memory] offload MMD assembly failed: ${String(error)}`);
      return null;
    }
  }

  // ── tools ────────────────────────────────────────────────────────────────
  // `toolsEnabled` defaults to true (schema `.default(true)`), so only an
  // explicit `false` turns the two search tools off. Read through
  // `runtimeConfigOf` — the volatile row config has no plain properties (#3).
  let toolsRegistered = false;
  let toolsDeferred = false;
  let toolsDisposers = [];

  /** The core, or a clear error while the first build is still in flight. */
  function requireCore() {
    if (!core) throw new Error("tdai-memory is still initializing; retry this call in a moment");
    return core;
  }

  function registerTools(tools) {
    if (toolsRegistered) return;
    if (typeof tools?.register !== "function") {
      ctx.logger.warn("[tdai-memory] tools service does not expose register(); search tools stay unavailable");
      return;
    }
    toolsRegistered = true;
    toolsDisposers = [
      tools.register(defineTool({
        name: "tdai_memory_search",
        description:
          "Search structured long-term memories (facts, preferences, and experiences extracted from past conversations). " +
          "Use this to recall what the user told you or what happened in earlier sessions.",
        parameters: {
          query: { type: "string", required: true, description: "The memory to search for." },
          limit: { type: "integer", description: "Maximum results (default 5)." },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args) {
          const result = await requireCore().searchMemories({ query: args.query, limit: args.limit ?? 5 });
          return result.text;
        },
      })),
      tools.register(defineTool({
        name: "tdai_conversation_search",
        description:
          "Search raw past conversation logs (L0) by keyword. Use this to look up exact quotes or details " +
          "that structured memory search does not cover.",
        parameters: {
          query: { type: "string", required: true, description: "Text to find in past conversations." },
          limit: { type: "integer", description: "Maximum results (default 5)." },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args) {
          const result = await requireCore().searchConversations({ query: args.query, limit: args.limit ?? 5 });
          return result.text;
        },
      })),
    ];
    ctx.logger.info("[tdai-memory] tools registered: tdai_memory_search, tdai_conversation_search");
  }

  function unregisterTools() {
    for (const dispose of toolsDisposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        ctx.logger.warn(`[tdai-memory] tool dispose failed: ${String(error)}`);
      }
    }
    toolsRegistered = false;
    ctx.logger.info("[tdai-memory] tools unregistered (toolsEnabled=false)");
  }

  /** Align tool registration with the live `toolsEnabled` value. */
  function syncTools() {
    if (runtimeConfigOf(config)?.toolsEnabled === false) {
      if (toolsRegistered) unregisterTools();
      return;
    }
    if (toolsRegistered || toolsDeferred) return;
    // `tools` is in this plugin's `inject`, so the service is normally live
    // here; `ctx.inject` is the fallback for hosts that mount it later. The old
    // one-shot `ctx.tools` property read registered nothing and said nothing.
    const tools = ctx.tools ?? ctx.get?.("tools");
    if (tools === undefined) {
      toolsDeferred = true;
      ctx.logger.warn("[tdai-memory] tools service not ready; deferring search-tool registration");
      ctx.inject(["tools"], (toolCtx) => {
        toolsDeferred = false;
        const deferred = toolCtx.tools ?? toolCtx.get?.("tools");
        if (deferred === undefined) {
          ctx.logger.warn("[tdai-memory] tools service still unavailable; search tools stay unavailable");
          return;
        }
        registerTools(deferred);
      });
      return;
    }
    registerTools(tools);
  }

  // `toolsEnabled` is a volatile config path, so flipping it (Plugins page)
  // updates the running fiber in place instead of remounting this plugin: the
  // loader reports that as `loader/volatile-update`, and this keeps the
  // registration in sync with the new value.
  ctx.on("loader/volatile-update", () => {
    try {
      syncTools();
    } catch (error) {
      ctx.logger.warn(`[tdai-memory] tool sync failed: ${String(error)}`);
    }
  });

  syncTools();

  // ── configuration changes ─────────────────────────────────────────────────
  // Configuration lives in the Plugins page (client.js → configForms), i.e. in
  // this row's own config. Because the row schema is `.volatile()`, an edit is
  // applied to the running fiber in place — the loader reports it as
  // `loader/volatile-update` (the tools above re-sync on it) — while TdaiCore
  // is built at startup, so an edit that must reach the core needs a plugin
  // reload. Legacy settings documents are only reported here.
  ctx.on("settings/document-updated", (id) => {
    if (id === NS) ctx.logger.warn("[tdai-memory] settings updated; restart to apply (TdaiCore is built at startup)");
  });

  // Deferred first build (see the note at the top of apply).
  setTimeout(() => {
    if (!builtOnce) {
      builtOnce = true;
      void build(runtimeConfigOf(config)).catch((error) => {
        log("error", `initialization failed: ${String(error)}`);
      });
    }
  }, 500);

  // ── lifecycle ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    return async () => {
      // Final flush: run pending L1 extraction for every session seen this
      // process and wait for it to finish (headless exits right after the
      // tree disposes, so this is what makes extraction complete in one-shot
      // runs). Unknown keys are tolerated as no-ops.
      for (const sessionKey of seenSessions) {
        await core?.handleSessionEnd(sessionKey).catch((error) => {
          ctx.logger.warn(`[tdai-memory] final L1 flush failed for ${sessionKey}: ${String(error)}`);
        });
      }
      await core?.destroy().catch((error) => {
        ctx.logger.warn(`[tdai-memory] destroy failed: ${String(error)}`);
      });
    };
  }, "tdai-memory.cleanup()");
}

export { Config, apply, inject, name };
