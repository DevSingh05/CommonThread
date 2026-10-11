# Conversation engine delivery status

Implemented on `feature/conversation-engine`; other branches remain reserved for teammates. Merge this branch into your own before coding against the shared contracts.

## Working now

Persistent SQLite rooms, authored messages, runs/tasks/turns, independent sessions, idempotency receipts, immutable artifacts and pinned reviews. Deterministic sequential dispatch, validated structured actions, human addressing/mentions/questions, bounded attributed context with delivery cursors, pause/resume/stop, generation fencing, timeouts, conservative retries, turn/correction/loop limits and explicit crash/fresh-session recovery.

Local JSON/SSE server, browser request protections, process/data-directory ownership, canonical-path exclusion across rooms, future same-origin static UI serving, and explicit live-mode rejection until adapters/guards are registered. Deterministic two-agent fixture exercises the actual persistence/dispatcher/artifact/control paths.

## Validation

Validated on Node 24.20.0. The full `npm run check` runs strict typechecking, ESLint, offline Vitest tests and production TypeScript build. HTTP tests use actual ephemeral localhost listeners. `npm start` was launched from compiled output and `npm run demo` completed the five-turn API workflow, producing two artifact versions and two exact-version reviews; output reports fixture limitations and unresolved issues.

The test suite covers persistent reopen/rollback, authorship, duplicate input, invalid action batches, mentions, cross-room refs, ordinary messages without scheduling, context cursors/bounds, human guidance mid-turn, pause, late Stop responses, old Stop retries against new runs, provider-session reuse/fallback, invalid/stale artifacts, malformed reviews, conservative retries, failure redaction, turn/correction/loop limits, cross-room repository aliases, timeout ownership, interrupted restart, cancelled-run restart, live fail-closed behavior, guard ordering, HTTP request protection/history/SSE, and process ownership.

Final verification on 2026-10-11:

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 41 tests passed across 5 files |
| `npm run build` | Passed; compiled output in `dist/server` |
| `npm start` | Compiled server started at `127.0.0.1:4317` |
| `npm run demo` | Completed five simulated turns, two artifact versions, two pinned reviews |
| Real stop/restart, same SQLite directory | Earlier room restored with 15 messages, five turns, two versions, two reviews |
| `git diff --check` | Passed |

These are offline and API validations, **not live provider or browser UI validations**. The temporary smoke server used `/tmp/commonthread-startup-check`; the normal default remains `.commonthread/`.

## Teammate pickup

- Providers: import `AgentAdapter`, `AdapterInput`, `AdapterResult`, `actionBatchSchema` and errors in `src/core/errors.ts`; return actions, provider ID and honest usage. Read the guard hooks before enabling writes. Register in server composition only after both real adapters and safeguards exist.
- UI: start the API with `npm run dev:server`, use `/api/bootstrap`, `/api/rooms/:id` and room SSE. Render saved author/kind/reply/artifact refs; use `activeTurnId` and pending human IDs alongside run status. Build to `dist/web` and use the Vite proxy as documented.
- Repository/evidence: implement `RepositoryGuard`; return baseline from `beforeTurn` and capture post-turn results inside ownership. Engine locking does not provide dirty-file capture or external-change detection. Add real evidence/diff APIs without attributing fixtures as observed tests.

Exact startup: `npm ci`, `cp .env.example .env`, `npm run build`, `npm start`; another terminal: `npm run demo`. API: `http://127.0.0.1:4317`. No credentials required for this branch. Live credentials and SDK smoke tests belong to the provider branch and are unverified here.
