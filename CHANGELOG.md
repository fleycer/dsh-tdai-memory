# Changelog

## 0.6.0 (vendor sync + context offload)

- **Vendored upstream core synced to
  `@tencentdb-agent-memory/memory-tencentdb@1.0.3`** (143 compiled files):
  the previously missing `core/quota`, `core/state`, `core/storage`,
  `services/**` and the whole `offload/` module are now vendored — see
  [VENDOR.md](VENDOR.md) for the build procedure and the upstream's
  non-type-clean build notes. New runtime deps: `crc-32`, `js-tiktoken`.
- **Context offload ported (opt-in, `offload.enabled`, off by default)**:
  upstream Mermaid short-term memory (the −61% context-token feature) is
  wired into DSH — `tool/call`/`tool/result` events feed the upstream
  `before_tool_call`/`after_tool_call` hooks, and `engine.assemble()` runs
  per prompt assembly on a mapped **scratch copy** of the history; the
  resulting MMD is delivered as the `tdai:mmd` prompt context (ordered after
  `tdai:recall`/`tdai:profile`). Real session history is never touched —
  DSH's compaction subsystem stays its sole owner.
- **L3 history compression stays disabled by design** (`mildOffloadRatio`/
  `aggressiveCompressRatio` above any trigger): DSH compaction owns history;
  offload L1.5/L2 and tool-pair entries still feed the memory graph.
- Local offload mode speaks any OpenAI-compatible endpoint through `llm.*`
  (or `offload.model`); incomplete LLM settings disable offload with a
  warning instead of half-wiring it.
- Pure offload helpers live in `offload-runtime.js` (testable without booting
  the plugin). New tests: `tests/offload-runtime.test.mjs` (8 unit tests),
  `tests/offload-wiring.test.mjs` (8 static wiring contracts + 2 behavioural
  against the real schema and the assembly listener).

## 0.5.0 (fork hardening)

Fork maintenance release: no intentional behaviour change except the explicit
extraction-model guard below.

- **Extraction model default removed.** The previous default
  (`deepseek-v4-flash`) is documented as producing non-compliant JSON
  (extracts 0 memories), and the `parseConfig` fallback (`gpt-4o`) would call
  the configured endpoint with a placeholder model. L1 extraction now requires
  an explicit `llm.model` (or `TDAI_LLM_MODEL`); without one, extraction is
  disabled with a warning while capture and search keep working.
- **No unhandled rejection on init failure**: `build()` errors are caught and
  logged (`initialization failed: …`) instead of crashing the host.
- **API keys are never logged**, not even partially: debug/info logs now print
  `<set>` / `<empty>`.
- **Bounded per-session bookkeeping**: `lastTurnEnd` / `capturedTurns` /
  `turnStarts` / `seenSessions` are capped at 256 sessions (oldest evicted),
  so a long-lived web host no longer grows them without limit.
- **Captured message timestamps** use the source message timestamp (falling
  back to the turn start time) instead of `Date.now()` at capture time.
- **Tests are green in a clean checkout**: `tests/recall-runtime.test.mjs`
  skips its `recall-inject.js` behavioural tests with a reason when the DSH
  peer dependencies are not installed (previously the whole file failed and
  `tests/locale.test.mjs` never ran).
- **CI**: `.github/workflows/ci.yml` runs `npm test` on Node 22 and 24.
- **Docs**: README compatibility/install/upgrade sections corrected (version
  pins, `dist-dsh/` → `vendor/tdai/`, DSH 0.1.x guidance); `VENDOR.md` and
  `dsh-tsconfig.json` document the vendored upstream core and its rebuild.

## 0.4.2 and earlier

See the upstream repository:
<https://github.com/Scorp1o117/dsh-tdai-memory>.
