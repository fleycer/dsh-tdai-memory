# Vendored upstream core (`vendor/tdai/`)

`vendor/tdai/` is a tsc-compiled ESM snapshot of the host-neutral core of
**TencentDB Agent Memory** — upstream: [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory),
npm: [`@tencentdb-agent-memory/memory-tencentdb`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb).
The vendored code is kept **byte-for-byte unmodified** (zero changes policy);
all DSH-specific wiring lives in `index.js`, `recall-inject.js` and `client.js`.
License: Apache-2.0, see `THIRD-PARTY-NOTICES.md`.

## Module mapping

| Vendored output | Upstream source |
|---|---|
| `vendor/tdai/config.js` | `src/config.ts` |
| `vendor/tdai/core/**` | `src/core/**` |
| `vendor/tdai/utils/**` | `src/utils/**` |
| `vendor/tdai/adapters/standalone/**` | `src/adapters/standalone/**` |

## Rebuild / update procedure

1. Check out `TencentCloud/TencentDB-Agent-Memory` at the desired revision.
2. Copy `dsh-tsconfig.json` (repo root of this project) into that checkout.
3. Run `npx tsc -p dsh-tsconfig.json` — output lands in `vendor/tdai/`.
4. Copy the output back into this repo's `vendor/tdai/`, keeping the layout.
5. Run `npm test` here and fix the DSH shell (not the vendor) if signatures
   changed.

## Known drift (as of v0.5.0)

The snapshot predates `@tencentdb-agent-memory/memory-tencentdb@1.0.3`; the
following upstream modules are **not** vendored yet:

- `src/core/quota`, `src/core/state`, `src/core/storage`
- `src/offload` — the Mermaid short-term-memory offload (the −61% token
  feature); its absence is the main functional gap of this port.

The exact upstream commit of the snapshot was not recorded by the original
port, so treat `vendor/tdai/` as a **frozen snapshot**: before updating, diff
the exported function sets against the upstream tree (the vendored
`core/record/l1-extractor.js`, for example, matches upstream `l1-extractor.ts`
function-for-function) and re-verify after every sync. When porting the
missing modules, update this file and `CHANGELOG.md` in the same commit.
