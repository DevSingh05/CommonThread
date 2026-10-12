# CommonThread — team handoff

## Start here

**Integration update:** the human has now authorized merging the teammates' pushed work to `main`. The engine, providers and UI are integrated, with contract fixes and real-server browser validation. The repository/evidence remote still contains only the initial documentation commit. Read [integration status](docs/integration-status.md) before starting follow-up work; it supersedes the earlier engine-only delivery status below. Live mode remains disabled pending the repository guard, and the local Claude smoke is currently blocked by weekly quota.

The repository began empty. Four human teammates each own one branch. The current agent implements **only `feature/conversation-engine`**. The other branches are reserved for teammates and their own agents. These notes exist on every branch before implementation.

The complete product is a local shared room where a human, Claude, and Codex exchange explicit work requests, revise versioned results, and retain human control. A functioning engine alone is not the completed product. Do not present the demo as real provider work or a scaffold as a finished integration.

**Engine pickup update:** the engine implementation now supplies the actual shared contracts, localhost API, offline demo, tests and root tooling. Merge `origin/feature/conversation-engine` as instructed below and read [engine status](docs/engine-status.md), [README](README.md) and [architecture](docs/architecture.md). The other three feature branches intentionally still begin with only the common handoff documents.

## Branches and file ownership

| Branch | Owner | Owned implementation | Detailed brief |
| --- | --- | --- | --- |
| `feature/conversation-engine` | Teammate 1 / current workspace | `src/contracts.ts`, `src/core/**`, `src/server/**`, `src/adapters/demo.ts`, core/API tests, initial root tooling | [Conversation engine](docs/handoffs/conversation-engine.md) |
| `feature/provider-adapters` | Teammate 2 | `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/live.ts`, `src/adapters/provider-*.ts`, provider tests, `docs/providers.md` | [Provider adapters](docs/handoffs/provider-adapters.md) |
| `feature/shared-room-ui` | Teammate 3 | `src/web/**`, `index.html`, `vite.config.ts`, UI/browser tests, UI assets | [Shared room UI](docs/handoffs/shared-room-ui.md) |
| `feature/repository-evidence` | Teammate 4 | `src/repository/**`, repository/evidence tests, `docs/repository-safety.md`, `docs/demo-script.md` | [Repository and evidence](docs/handoffs/repository-evidence.md) |

Shared root files (`package.json`, lockfile, TS/ESLint config, README, contracts, server composition) need small coordinated changes, not wholesale replacement. Each feature should add its own scripts/dependencies while retaining existing ones. Run `npm install` to resolve lockfile conflicts, do not hand-edit the lockfile. No teammate should rewrite the engine or create a second data store.

### Repository evidence pickup

`feature/repository-evidence` now supplies `createRepositoryGuard(store, options)`, `canonicalizeRepository(path)`, immutable captures in the existing SQLite artifact store, and repository acceptance tests. See [repository safety](docs/repository-safety.md), [actual status](docs/repository-status.md), and [demo script](docs/demo-script.md). No shared TypeScript contract or teammate implementation was changed.

Integration coordination: the engine owner should normalize live room creation with `canonicalizeRepository(path).root` before its existing path-based ownership check. Until then, select the Git root; the guard rejects subdirectories. The provider owner should translate `guard.getTurnContext(roomId, turnId)` into verified SDK cwd/permissions and fail closed if unsupported. Explicit write/command approvals must come from trusted human state. Human external-change acknowledgement needs an engine-owned protected handler; it must never be exposed to provider tools. Capture artifacts already use `ArtifactRef` and appear as system artifact messages; final captures become available after provider execution, before engine action commit. Default server composition and live capabilities remain unchanged pending these integrations.

## Git workflow

1. `git fetch origin`
2. `git switch <your-feature-branch>` (or `git switch --track origin/<your-feature-branch>` on a fresh clone).
3. Before coding against the engine, `git merge origin/feature/conversation-engine`. It supplies shared TypeScript contracts and runnable tooling. If the engine is still in progress, use this document as the provisional agreement and merge its completed foundation before integration.
4. Work only in your owned files. Make coherent milestone commits with the configured human identity. **Never add AI authorship/co-authorship.**
5. Push only your own feature branch. Open a PR against `main` when your branch-specific checks pass. Do not merge other teammates' unreviewed work or push directly to `main`.

All four branches start from the same documentation commit; their distinct purposes are intentional. `main` holds the initial team plan until the team integrates. Merge order: engine → providers/repository (independent once contracts exist) → UI integration → complete live workflow validation. The UI can build against the running engine and simulated adapters immediately; credentials must not block offline work.

## Stack and agreed boundaries

- Node 24.14+ LTS, npm, TypeScript ESM with strict typing.
- Node `node:sqlite` persistence, Zod action validation, Vitest offline tests, ESLint.
- Persistent localhost HTTP server, JSON API, server-sent events (SSE), React + Vite UI in teammate 3's branch.
- Same-origin production UI, Vite `/api` proxy for development; no hosted backend.
- Stable UUID IDs, ISO UTC timestamps, monotonically increasing persisted message sequence, participant IDs `human`, `claude`, `codex`, `system`.
- `src/contracts.ts` is the authoritative code contract after the engine lands. [API and protocol agreement](docs/contracts.md) describes the contract before then. Prefer additive changes and update both docs and tests.

## Non-negotiable behavior

- Plain messages never trigger agent work. A directed human message or validated `handoff` creates a queued turn. `@claude` / `@codex` can select an initial recipient; ambiguity must be rejected.
- One active turn per room, one CommonThread writer per canonical repository; sequential by default. Provider sessions are independent and cannot impersonate each other.
- Structured actions, trusted actor from turn state, idempotency keys, bounded context, durable queue, no SQL transaction across a provider call.
- New human guidance is saved immediately and delivered next turn; provisional streaming is not committed chat and cannot schedule work.
- Pause prevents new work. Stop increments run generation, requests cancellation, and rejects late scheduling. Do not claim an abort signal proves provider execution stopped.
- Crash recovery marks uncertain in-flight turns interrupted and does not replay them. Human recovery must acknowledge uncertainty.
- Immutable artifact versions; updates require base version. Reviews pin exact versions. Malformed reviews fail rather than becoming clean reviews.
- Default max 8 turns and 2 correction rounds, bounded retries/timeouts, honest available/unavailable usage. No invented pricing.
- The app never commits, pushes, resets, or deletes user work automatically. User authorization to commit **this implementation** is not authorization for the app's agents to commit other repositories.

## Product acceptance across branches

1. Persisted room visible in a shared thread, human → Claude → Codex → Claude, with explicit structured handoffs and correct attribution.
2. Same flow through verified Claude Agent SDK and official Codex interface; supported sessions, streaming, cancellation, permissions and auth. If auth is absent, mark live validation unverified.
3. Human messages/questions, goal changes, pause/resume/stop, pending guidance, restart recovery.
4. Safe sequential repository implement → review → revise, preserve pre-existing modifications, review captured versions.
5. Artifact inspection, evidence, usage, tests, production build, server startup, browser refresh and 90-second demo.

Each teammate must leave a `docs/<area>-status.md` or update their handoff with actual checks, exact startup commands, integration changes, credentials needed, and known limitations. Do not claim the complete acceptance criterion until branches are integrated and the visible live conversation has been exercised.

