# Shared protocol agreement

`src/contracts.ts` on the engine branch will be authoritative. This document fixes the integration direction before implementation.

## Data model

Room: `id`, `title`, `goal`, optional `repositoryPath`, `mode` (`demo`/`live`), `createdAt`. Room has a separately persisted current run; room existence does not mean its goal is completed.

Run: `id`, `roomId`, `generation`, `status`, `maxTurns`, `turnCount`, `reason`, timestamps. Status describes scheduling: `running`, `waiting_for_user`, `paused`, `completed`, `failed`, `cancelled`, `interrupted`. Completed means queue drained, not proven goal success.

Task: `id`, `roomId`, `runId`, `title`, `status` (`open`, `in_progress`, `waiting_for_agent`, `waiting_for_user`, `completed`, `cancelled`), owner, correction count, summary, unresolved issues.

Turn: `id`, `roomId`, `runId`, `taskId`, `agent`, `generation`, `status` (`queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`), request and relevant message/artifact refs, attempts/times/usage. Active execution is tracked independently of run status.

Message: `id`, numeric `seq`, `roomId`, `author`, `kind`, `body`, `createdAt`, optional `recipient`, `replyTo`, `taskId`, `runId`, `artifactRefs`, structured `data`. Never move another actor's message into the receiving agent's assistant history.

Artifact: immutable `artifactId`, integer `version`, `roomId`, `title`, `content`, `createdAt`, trusted author, optional task association. References are `{ artifactId, version }`, never floating "latest" in reviews.

Session: `id`, `roomId`, `agent`, optional `providerSessionId`, repository identity, timestamps, `state`, last successful message cursor, sanitized provider metadata.

## Agent action union

All actions use `type` as discriminant. An adapter returns a **complete validated action batch**, not inferred commands from streaming prose. The engine derives author/task/run from the active turn. Unknown properties (especially supplied author IDs) are rejected.

- `post_message`: `body`, optional `recipient`, `replyTo`, `artifactRefs`.
- `handoff`: agent `recipient`, `taskId`, `request`, optional `relevantMessageIds`, `artifactRefs`, `revision` boolean (a requested correction counts toward the 2-round cap).
- `request_user_input`: `question`, optional `taskId`, `options`.
- `propose_decision`: `statement`, `rationale`, optional `taskId` (proposal is not a human instruction).
- `publish_artifact`: optional `artifactId`, `baseVersion`, required `title`, `content`. To reference an artifact in the same batch the adapter chooses its UUID; first version has no base, later versions require the current base.
- `complete_task`: `taskId`, `summary`, optional `evidenceRefs`, `unresolvedIssues`.
- `submit_review`: `artifactRef`, `summary`, `findings` with IDs, severity, file/line, explanation, evidence, suggested next action, and the exact reviewed version.

## Adapter contract

`AgentAdapter.execute(input): Promise<AdapterResult>` receives trusted agent/turn/session, bounded structured context, AbortSignal, and an `emit` callback for provisional public text/tool summaries. The result carries `actions`, provider session ID, optional sanitized metadata and usage (`reported` / `estimated` / `unavailable`). The engine commits the entire batch atomically after success; the delivery cursor advances only at that point. A local tool interface may collect actions during provider execution, but must not independently bypass this commit/identity boundary.

Adapters own provider auth, supported permission enforcement, resume compatibility, extracting public output, and cancellation. Resume failure must be explicit (`SessionResumeError`), with no silent new session. The engine exposes an explicit fresh-session recovery action. Retryable failures may be marked safe-to-retry only if the provider was never invoked; uncertain failures never auto-retry. Default live mode fails closed until both adapters and repository safeguards are registered.

Context includes goal, bounded latest human guidance, task/request, messages after cursor, explicitly referenced older messages, proposals, artifact refs, open questions. Messages retain original authors/IDs. SDK-specific prompt serialization belongs to provider adapters. Specific message/task/artifact retrieval belongs to the engine service, callable by provider tools.

## HTTP API

Base `/api`; JSON. `GET /api/health`, `GET /api/bootstrap` (local CSRF token and capabilities), `GET/POST /api/rooms`, `GET /api/rooms/:id` (snapshot), `POST /api/rooms/:id/messages`, `POST /api/rooms/:id/goal`, `POST /api/rooms/:id/control`, `GET /api/rooms/:id/events` (SSE), `GET /api/rooms/:id/artifacts/:artifactId/:version`, `GET /api/rooms/:id/messages/:messageId`, `GET /api/rooms/:id/tasks/:taskId`.

Mutations require `Content-Type: application/json`, `X-CommonThread-Token` from bootstrap, and `Idempotency-Key`. Body schemas/response types will be exported from contracts. Missing/invalid token, disallowed origin/host, malformed input, stale versions, and idempotency-key reuse with different input are errors. No wildcard CORS. Do not persist credentials in frontend storage or send provider auth to browsers.

Message input: `body`, optional `recipient` (`claude`/`codex`), `replyTo`. A recipient queues work; unaddressed messages only contribute context. Answer a pending question via `replyTo`; the question's trusted author determines the next agent. Control input `action`: `pause`, `resume`, `stop`, `recover`, `fresh_session`; recovery requires `acknowledgeUncertain: true`, fresh session requires `agent`. Snapshot and persisted event sequence allow refresh; SSE `snapshot` signals clients to refetch, and `stream` carries provisional output with turn ID. Do not rely on SSE delivery for durable correctness.

## Repository boundary

Engine owns canonical-path execution exclusion. Repository teammate supplies `RepositoryGuard.beforeTurn({room,turn,signal})` and `afterTurn(...)` to inspect baseline, preserve dirty state, detect changes, capture immutable diff/evidence, and configure supported read-only reviews. Engine must acquire repository ownership before calling either hook and release only after execution settles. Any shell/process execution must use argument arrays, no interpolated user shell strings. This interface can be extended additively with the engine owner.

