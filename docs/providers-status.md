# Provider adapters — status and continuation log

Branch: `feature/provider-adapters` (Teammate 2). This file is the hand-off log: any human or AI harness picking up this work should read it first, then `AGENTS.md`, `notes.md`, `docs/handoffs/provider-adapters.md` and `docs/providers.md`.

## Ground rules (from AGENTS.md — do not break)

- Only edit owned files: `src/adapters/{claude,codex,live,provider-*}.ts`, `tests/provider-*.test.ts`, `docs/providers.md`, this file. Small coordinated additions only to `package.json`, `.env.example`, `scripts/provider-smoke.ts`.
- **Never add AI author / co-author / generated-by lines to commits.** Commit with the configured human Git identity.
- Do not push to `main`; do not edit `src/core/**`, `src/server/**`, `src/contracts.ts`, `src/web/**`, `src/repository/**`.
- Never claim live behavior verified without a successful credentialed run.

## Current state

See the checklist below; it is updated at each milestone.

- [x] Merged `origin/feature/conversation-engine` (commit `33e1573`: contracts, store, context builder; dispatcher/server not yet landed on that branch).
- [x] Installed exact SDK versions: `@anthropic-ai/claude-agent-sdk@0.3.296`, `@openai/codex-sdk@0.162.1` (types inspected in `node_modules`).
- [x] `src/adapters/provider-protocol.ts` — prompt serialization, provider-neutral JSON schema, normalization/validation, usage, errors.
- [x] `src/adapters/provider-permissions.ts` — read-only vs workspace-write policy, path containment.
- [x] `src/adapters/claude.ts` — Claude Agent SDK adapter.
- [x] `src/adapters/codex.ts` — Codex SDK adapter.
- [x] `src/adapters/live.ts` — `createLiveAdapters` factory, fail-closed gating.
- [x] Offline tests `tests/provider-*.test.ts` (mocked SDK boundaries).
- [x] `scripts/provider-smoke.ts` + `npm run smoke:providers` (opt-in, credentialed).
- [x] `docs/providers.md` written.
- [x] typecheck / lint / test / build pass.
- [x] Live smoke run — **PASSED** 2026-10-11 (adapter-level; engine dispatcher path still unverified).

## Verified results (2026-10-11, Windows 11, Node 24.13.0)

- `npm run typecheck` ✓, `npm run lint` ✓, `npm test` ✓ (3 files, 35 tests: 3 engine store + 32 provider), `npm run build` ✓.
- Note: package.json requires Node >=24.14; this machine has 24.13.0 (npm only warns).
- Local CLIs: `codex-cli 0.162.1` logged in via ChatGPT; Claude Code login used by the Agent SDK.
- **Live smoke (`npm run smoke:providers`) PASSED twice.** Final run: Claude new session `46aadfc6-…` → handoff to Codex (new thread `01a12d32-35ec-…`) → handoff back to Claude, which **resumed the same session** `46aadfc6-…` and returned `complete_task`. Reported usage: Claude 7287/355, Codex 18326/305, Claude 9170/515 (input/output tokens).
- Scope of that claim: adapters driven directly with an in-memory context. Not yet run through the engine dispatcher/server (not landed), retrieval tools, write policy, cancellation or permission denial against live providers.
- Issues found by the first live run and fixed (with offline regression tests): (1) Windows native `claude-agent-sdk-win32-x64` optional dep was missing after the first `npm install`; a second `npm install` fetched it. If you see "Native CLI binary for win32-x64 not found", rerun `npm install`. (2) Claude `input_tokens` excludes cache reads/writes (reported 2), now summed with `cache_read_input_tokens` + `cache_creation_input_tokens`. (3) The SDK warned that `allowedTools` shadowed `canUseTool`; retrieval tools are now gated in `canUseTool` (`mcpServer.source === 'sdk'`). (4) The SDK's internal `StructuredOutput` tool is hidden from activity.

## Next steps for whoever continues

1. Live smoke is done (see above). Rerun it only with user consent (real quota) after adapter changes; record outcomes here. On Windows PowerShell: `$env:COMMONTHREAD_LIVE_SMOKE = "1"; npm run smoke:providers`.
2. When `origin/feature/conversation-engine` lands its dispatcher/server, merge it and hand the engine owner the registration snippet in `docs/providers.md` ("Engine registration"). Do not edit `src/server/**` yourself.
3. Coordinate with teammate 4 for a write-capable `PolicyResolver` and Codex `command_execution` → observed-evidence wiring.
4. Open a PR against `main` from `feature/provider-adapters` when the user asks (do not push unasked).

## Log

- 2026-10-11: Cloned, merged engine foundation, installed SDKs, started implementation.
- 2026-10-11: Implemented protocol, permissions, Claude/Codex adapters, live factory, offline tests, smoke script, docs. All local checks green. Committed locally (not pushed).
- 2026-10-11: Live smoke passed; fixed Claude usage accounting, canUseTool shadowing, StructuredOutput noise; documented Windows native-binary install quirk.
