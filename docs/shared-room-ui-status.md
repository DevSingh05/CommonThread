# Shared room UI — status

Branch: `feature/shared-room-ui` (teammate 3). Owned files only: `src/web/**`, `index.html`, `vite.config.ts`, `public/` (UI assets), UI tests under `test/web/**`, and this document.

## State of integration

`origin/feature/conversation-engine` had no implementation when this branch was built (it still pointed at the initial docs commit), so it was merged as a no-op. Per `notes.md`, the UI was built against the provisional agreement in `docs/contracts.md`:

- **`src/web/contract.ts`** is the single place the UI declares wire shapes (Zod schemas plus request types). When `src/contracts.ts` lands, replace these declarations with re-exports/adapters from it; components import only from this module.
- **`test/web/mock-engine/`** is an in-memory, test-only stand-in for the engine HTTP API. It is not a second data store for the app, it has no SQLite and no provider, and every agent output it produces says *simulated*. It exists so the browser flow can be exercised now. **Rerun the browser suite against the real engine after the merge.**

Nothing here has been verified against the real engine or real providers. Live mode stays disabled in the UI until `/api/bootstrap` reports it available.

## Commands

Node ≥ 22.12 (the team target is 24.14+; this branch was verified on Node 22.23.1), npm.

```sh
npm install
npm run typecheck:web     # tsc -p tsconfig.web.json
npm run lint:web          # eslint (strict type-checked + react-hooks)
npm run test:web          # vitest unit/component tests (jsdom)
npm run build:web         # vite build -> dist/web
npm run test:browser      # Playwright in installed Google Chrome; starts mock engine :4399 and Vite :5199
npm run check:web         # typecheck + lint + unit tests + build
```

Local UI development:

```sh
npm run mock-engine       # mock engine on 127.0.0.1:4317 (or run the real engine there)
npm run dev:web           # Vite on http://127.0.0.1:5173, proxies /api -> 127.0.0.1:4317
```

`COMMONTHREAD_API_PORT` / `COMMONTHREAD_WEB_PORT` override the ports. Playwright uses the `chrome` channel (installed Chrome) so no browser download is needed; set `PLAYWRIGHT_CHANNEL=chromium` after `npx playwright install chromium` to use the bundled build.

## Verified outcomes (2026-10-11, macOS, Node 22.23.1, Chrome 154)

| Check | Result |
| --- | --- |
| `typecheck:web` | pass |
| `lint:web` | pass, 0 problems |
| `test:web` | 39 tests / 8 files pass |
| `build:web` | pass; `dist/web` JS 482 kB (146 kB gzip), CSS 16 kB |
| `test:browser` | 12 / 12 pass against the **mock engine** |

Browser tests (`test/web/browser/room.spec.ts`):

1. Create demo room → `@claude` → Claude provisional output (labelled provisional and simulated) → Claude handoff card to Codex → Codex question → answer via option button (recipient locked to Codex) → review finding + correction-round handoff → Claude v2 → Codex clean review → task complete; run shows "Queue drained" with the note that this is not proof the goal is met. Stale inspection of v1 (superseded banner, pinned review), diff v1→v2, Escape closes the dialog, refresh restores the same messages, tasks and artifacts.
2. Pause during Claude's turn: header says the current turn may still finish; Codex's handoff turn stays queued; Resume starts it.
3. Stop during stream: run shows Stopped, provisional output is dropped, no handoff is committed, Stop disables.
4. Guidance sent mid-turn: hint says it is not injected into the current turn; message is tagged "Saved · delivered next turn" until a turn whose context includes it starts.
5. API failure (HTTP 503): message shows the code, draft is kept, Retry reuses the same `Idempotency-Key`; the next distinct send uses a new key.
6. SSE drop: UI reconnects and refetches history committed while disconnected (a message that emitted no SSE notification).
7. Interrupted run: explanation of unknown side effects; Recover requires the acknowledgement checkbox and sends `acknowledgeUncertain: true`.
8. Fresh session: dialog states the previous session is not resumed; session shows "fresh".
9. Ambiguous `@claude` + `@codex` blocks send; Ctrl/⌘+Enter sends; plain messages schedule nothing.
10. Live mode and repository path are disabled with the engine-supplied reasons.
11. Untrusted Markdown: no raw HTML, no `javascript:` links, no remote image loads; the CSRF token is never rendered into the page.
12. 390 px viewport: no horizontal overflow, rooms and details open as drawers.

Screens were also checked manually in light and dark mode at 1440 px and 390 px.

## UI behaviour summary

- **Single source of truth:** the server snapshot. SSE `snapshot` events only trigger a refetch; refetch also runs on SSE (re)open, tab visibility, `online`, every 10 s while disconnected and every 30 s while connected (a dev proxy can keep a dead stream looking open). `stream` events go to a separate provisional buffer rendered as plain text, never Markdown, never parsed, and dropped once the turn is no longer running.
- **Mutations:** same-origin JSON with `X-CommonThread-Token` from `/api/bootstrap` and one UUID `Idempotency-Key` per logical submit (`src/web/api/submission.ts`). Retrying an unchanged payload reuses the key; a changed payload or a new message gets a new one. A rejected token is refreshed once and the same request is resent with the same key.
- **Responses are validated** with Zod at the client boundary; unknown properties are dropped; a mismatched response becomes a visible "unexpected response" error.
- **Composer** states whether a send starts work (recipient selector or a single `@mention`), adds shared context, or answers a question (routed to the asker; recipient locked). It warns that guidance during a running turn is delivered later.
- **Header:** prominent Simulated/Live badge, run status, turn count, active turn, queued count, Pause/Resume/Stop with explanations (paused ≠ stopped turn; stopped ≠ confirmed process exit), Recover for interrupted runs, and usage that only sums reported/estimated values and counts unavailable turns. No prices.
- **Details panel:** editable goal, latest guidance (with pending state), participants and session state with explicit fresh-session action, tasks with corrections `n/2` and unresolved issues, turn history, artifact versions, open questions and unresolved findings.
- **Artifacts** are opened by exact `{artifactId, version}`; superseded versions are flagged; reviews shown are those pinned to that version; text diff against the previous version.
- **Security:** Markdown via `react-markdown` with `skipHtml`, unsafe URLs rendered as text, images never loaded, ESLint bans `dangerouslySetInnerHTML`. Nothing is written to browser storage. The selected room lives in the URL hash so refresh reopens it.

## Contract assumptions the engine owner should confirm

These are what `src/web/contract.ts` expects; mismatches will surface as "unexpected response" errors rather than silent misbehaviour.

- `GET /api/bootstrap` → `{ token, capabilities: { demo, live, repository, recovery, freshSession } }`, each `{ available: boolean, reason?: string }`. Missing capabilities are treated as unavailable (demo/recovery/fresh default to available).
- `GET /api/rooms` → `{ rooms: Room[] }`, each optionally with `runStatus`.
- `POST /api/rooms` → `{ room }` or the room itself (the UI reads `id`).
- `GET /api/rooms/:id` → `{ room, run?, tasks, turns, messages, artifacts, reviews, sessions, eventSeq }`. Artifact entries may omit `content`; the UI fetches exact versions for content.
- Errors → `{ error: { code, message } }` with a meaningful HTTP status.
- SSE events: `snapshot` with `{ roomId, eventSeq }`, `stream` with `{ turnId, agent, kind: 'text' | 'tool', text }`.
- Message `kind` values rendered specially: `chat`, `handoff` (`data.request`, `data.revision`), `question` (`data.question`, `data.options`), `proposal` (`data.statement`, `data.rationale`), `decision`, `artifact`, `review` (`data.summary`, `data.findings`), `task_completed` (`data.summary`, `data.unresolvedIssues`), `activity` (collapsed), `system`. Unknown kinds render as plain attributed messages.
- Session delivery cursor named `deliveredSeq`.
- **Proposed additive field:** `Turn.contextSeq` (highest message `seq` in that turn's context). Without it the UI falls back to the active agent's `deliveredSeq` for pending guidance.
- **Suggested:** a periodic named SSE event (e.g. `ping`) so clients can detect a dead stream; comments are invisible to `EventSource`.

## Integration notes

- **Production same-origin serving:** the engine should serve `dist/web` (static files; routing is hash-based, so no SPA fallback is required) on the same localhost origin as `/api`. Server build output stays in `dist/server`.
- **Dev proxy:** `vite.config.ts` binds 127.0.0.1, proxies `/api` with `changeOrigin`, and rewrites `Origin` to the engine origin **only** when it is the Vite page's own origin, so the engine's same-origin check passes for the dev UI and still rejects any other origin.
- **Root tooling created here:** because the engine branch had no tooling yet, this branch adds `package.json` (UI scripts and dependencies, all suffixed `:web`), `package-lock.json`, `tsconfig.web.json`, `eslint.config.js`, `vitest.web.config.ts`, `playwright.config.ts`, and two `.gitignore` lines. On merge, keep the engine's scripts and config and add these; regenerate the lockfile with `npm install` rather than hand-editing it. `eslint.config.js` expects to gain the engine's TypeScript project.
- **TypeScript is pinned to `~6.0.3`** because `typescript-eslint` 8.71 supports `<6.1`.
- **Teammate 4:** the artifact viewer shows text content and a line diff. A structured repository change-set/diff renderer and the 90-second demo script still need to be coordinated.

## Known limitations

- Not verified against the real engine, real providers or live mode. Do not treat the mock-engine results as acceptance of the integrated product.
- Verified on Node 22.23.1, not the team's Node 24.14+ target.
- Repository association is UI-only until the engine reports the `repository` capability; the room form does not validate paths (the engine and repository guard must).
- No automated screen-reader audit; keyboard paths covered are the composer shortcut, native `<dialog>` focus handling with Escape, and standard buttons and form controls.
- The client-side line diff declines inputs whose line-count product exceeds 4 million cells.
