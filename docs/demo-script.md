# CommonThread: 90-second demo

These are two separate paths. Do not describe the simulated path as real model execution, repository implementation, or passing tests. The default server on this branch has no merged UI/live provider registration.

## Simulated path available now

Preparation, outside the 90-second presentation:

```powershell
# Use Node 24.14+ on 24.x; dependencies are local to this project.
# If installing for the first time and following this workspace's setup policy:
python -m venv .venv
npm ci
npm run build
npm start
```

In another terminal:

```powershell
npm run demo
```

The server binds `http://127.0.0.1:4317`. The demo creates a fresh persisted room each time; it prints its URL. The current root page is service information, not the future chat UI. A visible terminal/API walkthrough is available now; a browser conversation requires the UI branch.

| Time | Show and say |
| --- | --- |
| 0–15 s | “This is a simulated shared-room workflow. No providers, repository edits or tests run in this fixture.” Show the room ID and goal printed by `npm run demo`. |
| 15–35 s | Point to Claude v1, the explicit Codex review handoff and Codex's human question. Attribution is persisted; ordinary prose does not authorize actions. |
| 35–55 s | Show the human constraint, handback and Claude v2. Open the room snapshot via `GET /api/rooms/<id>` or the merged UI if available. |
| 55–70 s | Show v1/v2 and exact-version reviews, unresolved issues, and unavailable usage. Explain that completion means the queue drained, not proof of correctness. |
| 70–90 s | Show repository acceptance test results. Explain that real temporary-repository tests exercise snapshots and command evidence separately from this simulated conversation. |

To rerun repository acceptance before presenting:

```powershell
npx vitest run tests/repository-snapshot.test.ts tests/repository-guard.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

Record fresh results. Never claim a command ran by displaying the fixture's assertion.

## Credentialed live path

Prerequisites: provider authentication configured per `docs/providers.md`, guard registration and canonical root normalization, protected human permissions/recovery controls, and a disposable repository approved by the human. Do not request or scrape credentials from browser sessions.

Before presenting, create a small disposable Git project with a test, commit its initial state manually, and add a harmless dirty human note plus an untracked file. Approve only the intended code edit/test operations. Verify both providers' read-only review enforcement with their supported SDK options. Keep Git mutations unapproved.

| Time | Live demonstration after prerequisites pass |
| --- | --- |
| 0–15 s | Human creates a room at the canonical root and explicitly asks Claude to fix the small behavior while preserving the dirty note/untracked file. Show the captured baseline. |
| 15–35 s | Show actual provider execution and immutable capture references; run the explicitly approved test command and inspect its observed exit status and output reference. |
| 35–55 s | Codex reviews the captured version with supported read-only permissions; show findings tied to that exact version. |
| 55–70 s | Human adds a constraint; an explicit correction handoff returns work to Claude. Show the revised capture and observed test result. |
| 70–90 s | Show Codex's new review, retained v1 findings, preserved pre-existing files and persisted history after refresh. Pause/stop controls remain visible. |

Live latency may exceed 90 seconds; prepare a previously recorded **actual** run and label replay explicitly if necessary. Missing credentials or branches mean this path remains unverified, not simulated success.

## Full acceptance checklist

- [x] Canonical roots, directory aliases and linked worktree identities exercised offline.
- [x] Clean/dirty/staged/untracked/deleted snapshots and immutable SQLite evidence exercised.
- [x] Two rooms serialize through the actual engine; failed provider execution releases ownership after capture.
- [x] Cancellation/final-capture failure, checkpoint/external changes and digest-pinned acknowledgement exercised.
- [x] Traversal/symlink escape and file/output/time bounds exercised in disposable repositories.
- [x] Exact-version reviews after newer publication and malformed findings exercised offline.
- [x] Observed process result separated from unverified agent claims and explicitly simulated fixtures.
- [ ] All checks pass on the documented Node version and an environment supporting the existing engine's symlink test.
- [ ] UI/provider branches merged; visible human → Claude → Codex → Claude flow verified with real authenticated sessions.
- [ ] Provider-supported read-only permissions and cancellation behavior verified live.
- [ ] Human permission/recovery handlers normalize repository roots and protect mutation requests.
- [ ] Live implement → review → revise flow preserves pre-existing edits and displays exact captured refs/evidence.
- [ ] Browser pause/resume/stop, human guidance, restart recovery and refresh verified after integration.
