# Changelog

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
