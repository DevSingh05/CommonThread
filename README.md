# CommonThread

A local shared project room for a human, Claude, and Codex. Explicit messages, handoffs, versioned work, and human control are the product.

This repository is being built by four teammates. **This branch implements the conversation engine only.** The React UI, live Claude/Codex integrations, and real repository evidence are assigned to the other three branches. Read [notes.md](notes.md) for ownership and integration order. This is working backend software with a complete simulated API workflow, not yet the integrated end-user application.

## Run locally

Requirements: Node **24.14+ on the 24.x LTS line** and npm. No API keys or hosted services are needed for the offline demo.

```sh
git switch feature/conversation-engine
npm ci
cp .env.example .env
npm run build
npm start
```

The server listens on `http://127.0.0.1:4317`. In another terminal:

```sh
npm run demo
```

The demo creates a persisted room and performs five simulated turns: Claude proposes v1 → Codex reviews and asks the human → human adds a constraint → Codex hands back → Claude publishes v2 → Codex reviews v2 and completes with unresolved issues. It prints attributed messages and the room URL. **The fixture does not call real models, edit a repository, or execute tests.** Re-running it creates another room; history is kept in `.commonthread/commonthread.sqlite`.

For engine development, `npm run dev` restarts on source changes. `.env` is loaded by the Node launcher. For a different local demo endpoint, use `COMMONTHREAD_URL=http://127.0.0.1:4320 npm run demo`.

The root URL currently returns service information. It will serve the UI when teammate 3 builds to `dist/web`; the engine does not include a placeholder chat UI. UI developers should merge this branch, proxy `/api` to port 4317 and enable their exact local Vite origin with `COMMONTHREAD_DEV_ORIGINS` in `.env`.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
# Or all four:
npm run check
```

Tests are offline. HTTP tests bind ephemeral loopback ports; restricted sandboxes may need permission for local listeners. The demo driver targets an already-running server. [Engine status](docs/engine-status.md) records actual validation and remaining scope.

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

- **Live mode unavailable:** intentional until the provider and repository branches register actual integrations. No credentials are needed or requested by this branch. Follow teammate 2's eventual `docs/providers.md`; no SDK/authentication claims have been live-verified here.
- **Port in use / `EADDRINUSE`:** stop the existing server or set `COMMONTHREAD_PORT` to a different local port. The demo's `COMMONTHREAD_URL` must match.
- **Listener permission / `EPERM`:** the environment is blocking localhost sockets. Allow local server execution in your development environment; binding remains `127.0.0.1`.
- **Data directory already owned:** use the running server. Each data directory supports one process. A stale lock is recovered only when its PID is confirmed dead. For an invalid lock or PID reuse, verify that no server owns the directory before manually removing `server.lock`.
- **Interrupted run:** inspect repository/process state, then use `{ "action": "recover", "acknowledgeUncertain": true }`. Interrupted turns never replay. If the session is interrupted, use `{ "action": "fresh_session", "agent": "claude", "acknowledgeUncertain": true }` (or `codex`) and send a new directed request. This creates a new provider session from shared context; it does not recover unknown side effects.
- **Run paused at a limit:** ordinary Resume does not reset the budget. Stop the run and send a new directed request after reviewing the reason.
- **Question awaiting input:** reply with its `message.id` in `replyTo`; the asking agent receives the answer. An unaddressed message without `replyTo` is saved as shared context only.
- **Frontend token expired after restart:** fetch `/api/bootstrap` again. Tokens are process-local and never belong in persistent browser storage.

Application limits are scheduling bounds, not guaranteed monetary caps. SQLite storage and full snapshot reads target hackathon-scale local rooms. This branch is not production-ready; see the explicit [limitations](docs/architecture.md#limitations-and-integration-work).

