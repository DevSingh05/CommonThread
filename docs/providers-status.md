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
- [ ] Live smoke run (needs credentials + user consent) — **UNVERIFIED** until run.

## Verified results (2026-10-11, Windows 11, Node 24.13.0)

- `npm run typecheck` ✓, `npm run lint` ✓, `npm test` ✓ (3 files, 34 tests: 3 engine store + 31 provider), `npm run build` ✓.
- Note: package.json requires Node >=24.14; this machine has 24.13.0 (npm only warns).
- Local CLIs present: `codex-cli 0.162.1` reports "Logged in using ChatGPT"; Claude Code 2.1.286 installed. **No live smoke has been run yet → live UNVERIFIED.**

## Next steps for whoever continues

1. With user consent (it spends real quota), run `COMMONTHREAD_LIVE_SMOKE=1 npm run smoke:providers` and record the outcome (session IDs, pass/fail, any SDK errors) here. If structured output or resume behaves differently from the types, fix the adapter and add an offline regression test.
2. When `origin/feature/conversation-engine` lands its dispatcher/server, merge it and hand the engine owner the registration snippet in `docs/providers.md` ("Engine registration"). Do not edit `src/server/**` yourself.
3. Coordinate with teammate 4 for a write-capable `PolicyResolver` and Codex `command_execution` → observed-evidence wiring.
4. Open a PR against `main` from `feature/provider-adapters` when the user asks (do not push unasked).

## Log

- 2026-10-11: Cloned, merged engine foundation, installed SDKs, started implementation.
- 2026-10-11: Implemented protocol, permissions, Claude/Codex adapters, live factory, offline tests, smoke script, docs. All local checks green. Committed locally (not pushed).
