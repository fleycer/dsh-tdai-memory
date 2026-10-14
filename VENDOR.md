# Vendored upstream core (`vendor/tdai/`)

`vendor/tdai/` is a tsc-compiled ESM snapshot of the host-neutral core of
**TencentDB Agent Memory** — upstream: [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory),
npm: [`@tencentdb-agent-memory/memory-tencentdb`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb).
The vendored code is kept **byte-for-byte unmodified** (zero changes policy);
all DSH-specific wiring lives in `index.js`, `offload-runtime.js`,
`recall-inject.js` and `client.js`. License: Apache-2.0, see
`THIRD-PARTY-NOTICES.md`.

## Snapshot pin

Synced to **`@tencentdb-agent-memory/memory-tencentdb@1.0.3`** (v0.6.0),
compiled with `dsh-tsconfig.json` from this repo. 143 emitted files. The
snapshot now includes the previously missing modules
(`core/quota`, `core/state`, `core/storage`, `services/**`, `offload/**`,
`offload-client/**`), so the Mermaid short-term-memory offload (the −61%
token feature) is vendored and wired.

## Module mapping

| Vendored output | Upstream source |
|---|---|
| `vendor/tdai/config.js` | `src/config.ts` |
| `vendor/tdai/core/**` | `src/core/**` |
| `vendor/tdai/utils/**` | `src/utils/**` |
| `vendor/tdai/services/**` | `src/services/**` |
| `vendor/tdai/offload/**` | `src/offload/**` |
| `vendor/tdai/offload-client/**` | `src/offload-client/**` |
| `vendor/tdai/adapters/standalone/**` | `src/adapters/standalone/**` |

## Rebuild / update procedure

1. Fetch the upstream sources at the desired revision (`npm pack
   @tencentdb-agent-memory/memory-tencentdb@<version>` and extract, or check
   out `TencentCloud/TencentDB-Agent-Memory`).
2. Copy `dsh-tsconfig.json` (repo root of this project) into that tree and run
   `npm install` there (types come from the real dependencies).
3. Run `npx tsc -p dsh-tsconfig.json` and copy the emitted files back into
   this repo's `vendor/tdai/`, keeping the layout.
4. Run `npm test` here and fix the DSH shell (not the vendor) if signatures
   changed.

Upstream is **not type-clean** against current dependency versions: the build
emits despite ~30 diagnostics (missing optional/type-only modules such as
`ioredis`, `@clickhouse/client`, `node-llama-cpp`, `openclaw-sdk`,
`integrations/observability`; AI-SDK property mismatches). Emitted-JS static
bare imports stay safe for load time: only `@ai-sdk/openai`, `ai`, `json5`,
`undici`, `js-tiktoken`, `crc-32`, `@tencentdb-agent-memory/tcvdb-text` and
`node:*` are required when the vendored modules are imported; the
observability/clickhouse paths are type-only or dead (nothing imports
`core/report/clickhouse-exporter.js`). `offload/benchmark-token-estimate.js`
is excluded from the build (its relative import stays broken) — it is a dev
benchmark, not used at runtime.

## Runtime deps added for the vendor sync (v0.6.0)

`crc-32` and `js-tiktoken` (upstream specs) are direct dependencies; they
landed in `package.json` alongside `@ai-sdk/openai`, `ai`, `json5`,
`sqlite-vec`, `undici`, `@tencentdb-agent-memory/tcvdb-text`,
`@node-rs/jieba`, `@deepseek-ai/schemastery` which the shell already needed.

## Offload integration contract (this fork)

- The DSH shell feeds upstream `before_tool_call` / `after_tool_call` hooks
  from `tool/call` / `tool/result` session events and calls
  `engine.assemble()` per prompt assembly on a **mapped scratch copy** of the
  message history (`offload-runtime.js#mapForOffload`). The injected MMD
  message is flagged `m._mmdContextMessage` upstream and is delivered as the
  `tdai:mmd` prompt context — real session history is never touched (DSH's
  compaction subsystem is its sole owner).
- **L3 history compression is disabled on purpose** (`mildOffloadRatio: 99`,
  `aggressiveCompressRatio: 99`): DSH compaction owns history, and offload L3
  would rewrite a scratch copy whose compressed form is discarded. L1.5/L2
  and tool-pair L3 side effects (entries, MMD) still work.
- Local mode (`mode: "local"`, `LocalLlmClient`) is the only mode wired: it
  speaks any OpenAI-compatible endpoint via `llm.*` (or `offload.model`).
  Backend/remote mode is not wired in `index.js`.
- `registerOffload()` receives a shimmed `api` object; the context-engine
  slot is forced to `plugins.slots.contextEngine: "memory-tencentdb"` —
  upstream no-ops every hook unless the slot matches the id it registers.
