# Teammate 3 — shared-room React UI

Branch: `feature/shared-room-ui`. Own `src/web/**`, `index.html`, `vite.config.ts`, UI/browser tests and assets. Merge `origin/feature/conversation-engine` first. Import types/schemas from `src/contracts.ts`; never duplicate server state in a separate database.

## Experience

Create a polished React + Vite browser interface whose center is a single attributed conversation. Left sidebar: rooms, create room, repository association. Main thread: human/Claude/Codex/system messages, direct recipients, reply links, handoff cards, questions, proposal/decision distinction, artifact links, collapsed activity/diagnostics, distinct provisional output. Right panel: editable goal, latest human guidance, participants/session state, tasks, exact artifact versions, unresolved questions/findings. Header: prominent simulated/live badge, run and active-turn status, pause/resume/stop, honest available usage.

Composer: body, recipient selector, supported @mentions, reply/question answer context, send; say whether it starts work or adds shared context. Human input must remain usable during execution. Show guidance as pending if its sequence exceeds the active agent's delivered cursor. Do not claim mid-turn steering. Paused state does not mean the current turn has stopped. A stopped run can still have an unconfirmed in-flight process; reflect server state faithfully.

## Integration

Read `/api/bootstrap` for CSRF token and capabilities. Send same-origin JSON mutations with `X-CommonThread-Token` and one UUID `Idempotency-Key` per logical submit; reuse the key on retry, not across distinct messages. Read snapshot after SSE notifications; never treat provisional stream text as committed messages or parse it into actions. Reconnect/refetch after refresh and visibility/reconnect events so lost SSE does not lose history. Render Markdown safely without raw HTML injection.

Configure Vite `/api` proxy to the local engine (default 4317), production output `dist/web`, and keep server build in `dist/server`. Add React/Vite dependencies and scripts without replacing engine checks. Work with engine owner for static same-origin serving, or document a local same-origin proxy. Do not deploy on a serverless host.

Live creation must stay disabled when capabilities report missing adapters/safety hooks; demo output must always be marked simulated. Disable incompatible controls with plain-language explanations. Surface HTTP error codes as useful messages. Recovery from interrupted work must explain unknown side effects and require acknowledgement; fresh session must be explicitly labeled, never "resumed".

## Acceptance

Browser test: create demo room → address Claude → observe Claude handoff to Codex → answer Codex question/constraint → Claude revision → Codex review → pinned final artifact. Refresh restores the same messages, tasks and artifacts. Exercise pause before handoff, resume, stop during stream, pending human guidance, stale artifact inspection, API failure and SSE reconnect. Keyboard/focus support, readable narrow layout, no secret/provider internals leaked. Typecheck/lint/tests/build and real browser checks.

Coordinate with teammate 4 on artifact/diff renderer and 90-second demo script. Leave precise commands, verified browser outcomes and remaining limitations. Do not claim live verification based on fixtures.

