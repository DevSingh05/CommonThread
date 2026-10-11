# Teammate 1 — conversation engine

Branch: `feature/conversation-engine`. Current agent owns this branch only.

## Deliver

Build the executable Node/TypeScript server, shared Zod schemas and adapter interfaces, SQLite persistence, deterministic dispatcher and bounded context builder. Include deterministic Claude/Codex demo adapters that exchange a versioned fixture through the same scheduling/action path used by future real providers.

Persist rooms/messages/tasks/runs/turns/sessions/actions/artifacts/reviews. Ensure stable IDs, idempotency scoped to operation and payload, trusted authorship, atomic action batches, foreign-room reference rejection, delivery cursor tracking, separate lifecycle states, 8-turn and 2-correction limits, timeouts and conservative retries.

Human API: initial addressing/mentions, context-only messages, answering questions, goal updates, pause/resume/stop, explicit crash recovery and explicit fresh-session fallback. Save guidance during execution immediately. Generation fences stop late results; no provider call inside DB transactions. Emit provisional stream events and durable snapshot notifications.

Create a localhost-only API with token/origin/host protection and graceful shutdown. Expose capabilities so the UI can clearly disable unimplemented live/repository features. Do not implement live SDKs, the React UI, or Git baseline/diff capture owned by teammates.

## Acceptance tests

Two-way handoffs and authorship; unaddressed messages do not schedule; invalid action/batch rollback; duplicate requests/handoffs; context cursor and relevant refs; mid-turn human input; pause/stop including cancellation-ignoring adapters; session reuse and explicit fresh fallback; bounded pre-invocation retry; uncertain provider failures; limits and loop protection; repository lock; artifacts/stale writes/review revision; persisted restart and explicit interrupted recovery; HTTP protections/history and real server smoke workflow.

## Handoff

Document exact npm commands, exported engine constructor/hooks and API shapes, status semantics, actual test counts, and unimplemented integration requirements. Commit foundation/persistence, scheduling, API/demo/tests at meaningful checkpoints. Leave teammates a clean tested branch to merge.

