# CommonThread

A local shared project room for a human, Claude, and Codex. Explicit messages, handoffs, versioned work, and human control are the product.

The shared-room React UI, persistent conversation engine, and Claude/Codex adapters are integrated. **The browser demo works end to end through the real server and SQLite store. Live coding remains disabled until the repository/evidence teammate pushes the safety guard and evidence integration.** Read [integration status](docs/integration-status.md) for verified behavior and remaining work, and [notes.md](notes.md) for team ownership.

## Run locally

Requirements: Node **24.14+ on the 24.x LTS line** and npm. No API keys or hosted services are needed for the offline demo.

```sh
git switch main
git pull --ff-only
npm ci
cp .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:4317** in your browser. Create a simulated room and send `@claude propose a cache fix`. Answer Codex's question with "Keep the public API unchanged" to watch the revision and final review in the same thread. To exercise the API from another terminal:

```sh
npm run demo
```

The demo creates a persisted room and performs five simulated turns: Claude proposes v1 → Codex reviews and asks the human → human adds a constraint → Codex hands back → Claude publishes v2 → Codex reviews v2 and completes with unresolved issues. It prints attributed messages and the room URL. **The fixture does not call real models, edit a repository, or execute tests.** Re-running it creates another room; history is kept in `.commonthread/commonthread.sqlite`.

For engine development, `npm run dev` restarts on source changes. `.env` is loaded by the Node launcher. For a different local demo endpoint, use `COMMONTHREAD_URL=http://127.0.0.1:4320 npm run demo`.

The production server serves the built React UI from `dist/web` on the same origin as the API. For frontend development, run `npm run dev:server` and `npm run dev:web` in separate terminals; Vite proxies `/api` to the engine. The root URL reports a missing build if you have not run `npm run build`.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
# Or all four:
npm run check
# Browser checks (installed Google Chrome by default):
npm run test:integration  # built UI + real server/SQLite/dispatcher
npm run test:browser      # UI-specific error/reconnect tests with the test-only mock
```

These tests are offline. HTTP/browser tests bind loopback ports; restricted sandboxes may need permission for local listeners and browsers. Install Chrome, or install Playwright Chromium and set `PLAYWRIGHT_CHANNEL=chromium`. The demo driver targets an already-running server. [Integration status](docs/integration-status.md) records actual validation and remaining scope.

## API

`GET /api/bootstrap` returns a local mutation token and capabilities; live is currently `false`. All mutations require JSON, `X-CommonThread-Token`, and a distinct `Idempotency-Key` per logical action. Reuse a key when retrying the **same** action. Cross-origin requests are rejected unless the exact loopback development origin is explicitly configured; no wildcard CORS is emitted.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Startup health |
| `GET/POST /api/rooms` | List/create rooms |
| `GET /api/rooms/:id` | Complete persisted snapshot and active status |
| `POST /api/rooms/:id/messages` | Save human context or direct one agent |
| `POST /api/rooms/:id/goal` | Save the current human goal |
| `POST /api/rooms/:id/control` | Pause/resume/stop/recover/fresh session |
| `GET /api/rooms/:id/events` | SSE snapshot notifications and provisional streams |
| `GET /api/rooms/:id/messages/:messageId` | Targeted message retrieval |
| `GET /api/rooms/:id/tasks/:taskId` | Targeted task retrieval |
| `GET /api/rooms/:id/artifacts/:artifactId/:version` | Immutable artifact version |

Requests and responses are defined in [src/contracts.ts](src/contracts.ts). [Protocol details](docs/contracts.md) and [architecture](docs/architecture.md) explain states, ownership and extension hooks. Provider adapters must not parse streamed prose into actions.

## Troubleshooting

- **Live mode unavailable:** intentional until the repository guard/evidence integration arrives. Adapters are present; `COMMONTHREAD_LIVE=1` alone does not bypass the missing safeguard. See [provider setup](docs/providers.md). No credentials are needed for the simulated browser demo.
- **Port in use / `EADDRINUSE`:** stop the existing server or set `COMMONTHREAD_PORT` to a different local port. The demo's `COMMONTHREAD_URL` must match.
- **Listener permission / `EPERM`:** the environment is blocking localhost sockets. Allow local server execution in your development environment; binding remains `127.0.0.1`.
- **Data directory already owned:** use the running server. Each data directory supports one process. A stale lock is recovered only when its PID is confirmed dead. For an invalid lock or PID reuse, verify that no server owns the directory before manually removing `server.lock`.
- **Interrupted run:** inspect repository/process state, then use `{ "action": "recover", "acknowledgeUncertain": true }`. Interrupted turns never replay. If the session is interrupted, use `{ "action": "fresh_session", "agent": "claude", "acknowledgeUncertain": true }` (or `codex`) and send a new directed request. This creates a new provider session from shared context; it does not recover unknown side effects.
- **Run paused at a limit:** ordinary Resume does not reset the budget. Stop the run and send a new directed request after reviewing the reason.
- **Question awaiting input:** reply with its `message.id` in `replyTo`; the asking agent receives the answer. An unaddressed message without `replyTo` is saved as shared context only.
- **Frontend token expired after restart:** fetch `/api/bootstrap` again. Tokens are process-local and never belong in persistent browser storage.

Application limits are scheduling bounds, not guaranteed monetary caps. SQLite storage and full snapshot reads target hackathon-scale local rooms. This application is not production-ready; see the explicit [limitations](docs/architecture.md#limitations-and-integration-work).

