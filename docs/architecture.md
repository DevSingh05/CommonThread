# Conversation engine architecture

Integration status: the React UI and provider adapters have now landed; [the integration report](integration-status.md) supersedes the engine-only scope statements below. Repository guard/evidence implementation is still missing, so live execution remains disabled.

## Execution path

An authenticated local human mutation is schema-validated and saved transactionally with its idempotency receipt. A directed message creates one task and queued turn. The scheduler acquires room and canonical-directory ownership, builds attributed context, then calls the selected adapter outside any SQL transaction. A successful adapter result is validated as a whole; its actions, visible messages, versions, reviews, session cursor and completed turn commit together. An explicit handoff queues the next recipient. Ordinary messages do not schedule work.

`Store` uses Node 24's built-in [`DatabaseSync`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) with WAL, FULL synchronous durability, a schema version, indexed room IDs, stable IDs and monotonic message sequences. Entity bodies are typed JSON documents in separate tables. The engine enforces cross-room references and immutable artifact/version rules. Low-level Store is a trusted server-internal interface, not an agent API. The server never holds SQL transactions across provider calls.

## State model

- **Room** persists independently of any run and has a fixed demo/live mode, goal and canonical local directory.
- **Run** owns generation and budget. `running` allows dispatch; `paused` prevents dispatch but permits in-flight commits; `waiting_for_user` has no runnable turn but unresolved work; `completed` has drained the queue and all tasks returned results. `failed`, `cancelled`, and `interrupted` block further scheduling. Completion is a human-review checkpoint, never correctness proof.
- **Task** remains `open`/`in_progress` until handed off (`waiting_for_agent`), blocked on a question (`waiting_for_user`), returned with a summary (`completed`) or stopped (`cancelled`). Unresolved issues remain explicit even after task completion.
- **Turn** is `queued`, `running`, `completed`, `failed`, `cancelled` or `interrupted`. A cancelled run can still have an active running call until it settles; the UI must use both fields.
- **Session** is independent per room/agent with a provider ID kept out of HTTP snapshots. State is `fresh`, `running`, `ready`, `resume_failed` or `interrupted`. An explicit fresh-session action clears the old provider ID and cursor and records that a new session will start.

No agent can set its own author identity. Its trusted turn supplies actor, task and run. Schema-strict actions reject spoofed author fields. Batches can contain at most one handoff/question/completion transition and roll back in full on an invalid action. Reviews store exact immutable artifact references; v1 findings never silently transfer to v2.

## Delivery and recovery

HTTP idempotency keys are scoped to operation/room and hashed canonical payload. The same request returns its original result; changed input conflicts. Each committed action batch also has a unique turn receipt. These guarantees apply to **local persistence**, not exactly-once provider execution.

Context selects a contiguous page of undelivered messages, original-author references, the latest eight human messages, five proposals and eight unanswered questions. Message bodies are capped at 2,000 characters with truncated IDs for targeted retrieval; the current validated goal/request remain intact. Delivery cursor advances only after a valid committed result. A context page can include later human guidance without skipping the undelivered backlog; pending-guidance indicators account for what was actually included.

Streaming is bounded, provisional and non-durable; only `text` and public `activity` summaries are accepted. Streaming never commits or schedules. SSE sends `snapshot` notifications that clients refetch and `stream` events carrying turn IDs. Reconnect always begins with a refetch notification; clients must not depend on receiving every SSE event.

Pause lets in-flight work settle but does not follow its returned handoff. Stop increments the run generation, cancels queued turns and requests adapter cancellation. Late actions are discarded. The repository lock stays held until the adapter and guard hooks settle, even when they ignore abort. A timeout marks uncertain work interrupted and holds execution ownership rather than starting an overlapping writer.

On restart, in-flight turns become interrupted (including previously cancelled runs). Queued work on nonterminal runs is conservatively paused behind explicit recovery. Interrupted calls are **never** replayed. Recovery acknowledges uncertainty and may release previously queued work; a failed/interrupted provider session still needs explicit replacement before reuse. Only `BeforeInvocationError` permits bounded automatic retry; arbitrary provider failures are never retried. Provider SDK errors must not put secrets in public errors.

## Extension hooks

```ts
const engine = new Engine(store, {
  demoAdapters: createDemoAdapters(),
  liveAdapters: { claude: claudeAdapter, codex: codexAdapter },
  repositoryGuard,
});
```

`liveAdapters` and `repositoryGuard` are optional; without both, live room creation fails closed. Real adapter instances implement `AgentAdapter.execute(AdapterInput): Promise<AdapterResult>`. Use `input.retrieve` for room-scoped message/task/artifact lookup. Supply providerSessionId only after supported creation/resumption; return actual usage or `unavailable`. `SessionResumeError` requests explicit fresh-session handling. Do not mutate provider session history with another agent's words disguised as assistant messages.

The guard receives `beforeTurn({room, turn, signal})` and returns an opaque baseline; `afterTurn({room, turn, baseline, signal, outcome})` captures the result while execution ownership is still held. Demo deliberately skips guards and cannot produce real repository evidence. Guards/adapters own SDK permissions, cwd validation, safe code execution and baseline/evidence interpretation; core does not pretend to enforce provider sandboxing.

Teammate 3 builds the UI to `dist/web`; `startHttpServer` already serves it from the same origin. Vite development requires a `/api` proxy and an explicit local `COMMONTHREAD_DEV_ORIGINS` value. Teammate 2 wires adapters; teammate 4 wires guards. Keep all implementation in the ownership paths in `notes.md`.

## Limitations and integration work

- This branch has **no React UI, live SDK adapters or real code-edit/diff/test-evidence implementation**. They are deliberately reserved for the three teammates. The complete product acceptance criterion remains unverified.
- Provider authentication, real resume semantics, permission prompts, cancellation confirmation and token usage require SDK-specific verification. Permission UI/schema changes must be coordinated rather than approximated with a fake implementation.
- Repository exclusion coordinates this one CommonThread service and resolves filesystem symlinks; subdirectories within one Git worktree and multiple independent data directories need stronger shared identity/locking from teammate 4. It does not detect external editor changes or constrain provider permissions. Live mode stays disabled until that guard is supplied.
- Action batches commit after successful turns; a provider crash may lose uncommitted public output while leaving real side effects. This is intentional uncertainty, not an exactly-once claim. Do not auto-resume side-effectful provider execution.
- Context selection is deterministic and bounded but does not understand all old constraints semantically. Important persistent constraints belong in the goal. Full history remains available through snapshots/targeted retrieval. Snapshot reads load full room history and artifacts; pagination/compaction and large-repository scaling are not implemented.
- Demo fixture content is predetermined. Its artifact is a proposal, not a working patch, and its review/evidence explicitly says no code was changed or tests run. The demo's provider-style session IDs are simulated.
- Usage is stored per turn; demo usage is `unavailable`. Pricing, hard monetary limits and cost estimates are not implemented or invented.
- Local Host/Origin/fetch-metadata checks plus a process-local mutation token protect browser requests. This is not authentication against other processes running as the same OS user. No remote access or multi-user accounts are supported.
- Only message/goal/control HTTP mutations are exposed. Artifact publishing and reviews go through trusted turn results. A future browser artifact editor must use the same version checks and request protections.
- The stop/resume UI, production frontend build, real browser refresh and credentialed implement → review → revise workflow still need integrated validation.
