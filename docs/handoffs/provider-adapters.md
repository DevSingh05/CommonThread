# Teammate 2 — real Claude and Codex adapters

Branch: `feature/provider-adapters`. Own `src/adapters/{claude,codex,live,provider-*}.ts`, provider tests, and `docs/providers.md`. Do not replace demo.ts, the dispatcher, or the UI.

## Before code

Merge `origin/feature/conversation-engine`; inspect `src/contracts.ts`, engine composition and existing demo adapter. Read the full project requirements in the task and `notes.md`. Inspect installed SDK versions and actual exported TypeScript types. Read current official Claude Agent SDK and Codex SDK/official execution-interface docs, recording package versions, exact supported methods, source links and any limitations in `docs/providers.md`.

Verify independently for each provider: new sessions, resumption, structured outputs/custom tools, streaming public output, cancellation, permission requests, supported auth, usage. Never copy methods from an outdated blog. No consumer-app sessions, credential scraping, raw-model replacement coding agents, or unrestricted execution defaults.

## Implement

Export a `createLiveAdapters` factory from `src/adapters/live.ts` with one adapter per `claude` and `codex`, conforming to `AgentAdapter`. The engine controls scheduling; adapters do not independently wake agents or write engine tables.

Use a supported structured output schema or custom communication tools collecting validated actions. Derive actor from the input turn. Preserve other actors' labels in context and distinguish system instructions, human constraints, and untrusted repository/agent text. Do not deliver other agents' text as prior assistant messages. Supply targeted retrieval tools for exact message/task/artifact refs via the engine retrieval service.

Stream only public output/tool-result summaries, never reasoning or hidden chain-of-thought. Return the provider session ID and actual usage when available; use `unavailable` otherwise. Never fabricate token totals or prices. Limit execution and output through provider-supported options. On uncertain failure, do not mark retry safe. On resume failure throw `SessionResumeError`; do not silently create a new session. Honor AbortSignal using supported cancellation and report confirmation honestly.

Coordinate with teammate 4 to set execution cwd, read-only review capabilities and supported write permissions. Live execution must remain disabled until repository guards and permission handling are safe. Permission requests must be surfaced or fail closed with actionable errors. Define any additive permission lifecycle contract with the engine owner before editing shared files.

Use supported local CLI login or explicit env configuration only. Never send keys/provider metadata containing secrets to the UI or logs. Add placeholders to `.env.example`, not real credentials. Keep demo/live adapters separated and never substitute fixtures into live rooms.

## Tests and done criteria

Mock SDK boundaries for offline contract tests, including two-way handoff extraction, attribution, malformed structured output, streaming cancellation, permission denial, resume failure and usage absence. Separate credentialed smoke tests behind an explicit opt-in script. A successful credentialed test must show Claude → Codex → Claude with actual provider sessions and real requests. Without credentials, complete offline work and clearly report live as unverified.

Write exact setup/login commands verified in official docs, supported versions, permission/cancellation limits and live smoke outcomes. Coordinate a small server registration patch; retain default demo mode and fail-closed live behavior until configured. Commit coherent adapter and verification milestones with human identity only.

