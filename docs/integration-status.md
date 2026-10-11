# Team integration — 2026-10-11

The human requested review and integration of all pushed feature branches into `main`, superseding the earlier single-feature-branch implementation restriction for this integration task. Teammates' commits are preserved through merges; no branch was force-pushed or deleted.

## Inputs reviewed and merged

| Workstream | Remote tip reviewed | Result |
| --- | --- | --- |
| Conversation engine | `1a316cd` | Merged |
| Provider adapters | `95e310a` | Merged, including final teammate notes |
| Shared-room UI | `8694d93` | Merged; provisional wire assumptions reconciled with the engine |
| Repository/evidence | `302c68f` | Still the original documentation-only commit; no implementation exists on the remote branch to merge |

## Integration repairs

- Combined npm scripts/dependencies and regenerated the lockfile. Server and UI typechecks/tests remain separately runnable; root checks/build now include both. ESLint retains the UI's stricter checks without applying its TS project to unrelated server code.
- Adapted engine boolean capabilities, nested stream events, real review severity/next-action fields, session delivery cursors, explicit pending-guidance IDs, and completion/proposal message kinds for the UI.
- Shared authoritative agent/control types with the UI. Fresh-session requests now include uncertainty acknowledgement; replacement is shown only for failed/interrupted sessions and disabled while any turn remains active.
- Corrected active/queued turn display, limit-resume behavior, old interrupted-turn recovery buttons, room-title limit, and provisional output removal after Stop.
- Added stream author identity to engine events without allowing agent-supplied authorship.
- Added actual-server browser acceptance tests and an engine→UI schema integration test. Retained the UI's mock suite solely for its controllable failure/reconnect scenarios; its interrupt fixture now marks the affected session interrupted, like the engine.
- Made the canonical-directory lock test use directory junctions on Windows, avoiding the provider teammate's reported symlink-admin failure. This platform-specific path has not been rerun on Windows here.
- Clarified the provider prompt's one-transition-per-batch rule and how to reference a newly published artifact in a same-turn handoff.

## Actual verification

Environment: macOS, Node 24.20.0, installed Google Chrome.

| Check | Result |
| --- | --- |
| Dependency installation/audit | Completed, 0 reported vulnerabilities |
| Server and UI typechecks | Passed |
| Combined ESLint | Passed |
| Offline server/provider/integration tests | 74 passed across 8 files |
| UI unit/component tests | 39 passed across 8 files |
| Production server and Vite builds | Passed |
| Browser against compiled server + SQLite | 3 passed: conversation/revision/review/refresh, pause/resume/stop, context-only/mobile |
| UI mock-server browser cases | 12 scenarios verified; 11 passed in the full run, corrected fresh-session fixture passed on targeted rerun |
| Visual inspection | Desktop and 390 px screenshots inspected; no overflow or browser console errors in the production flow |
| Live provider smoke on this machine | Blocked on Claude's first turn by weekly account quota, before Codex could run |

Claude's supported CLI login-status command reported a logged-in `claude.ai` session; Codex reported ChatGPT login. No credentials were extracted or displayed. After installation completed, the Claude SDK returned: weekly limit reached, reset **October 14 at 2 p.m. America/New_York**. Do not repeatedly retry until quota is available or an authorized supported API-key configuration is supplied. The earlier provider teammate's recorded successful smoke remains historical evidence from their machine, not a fresh successful check here.

The full live engine/browser/repository workflow is **not verified**. Offline adapter tests mock SDK boundaries; browser demo contributions/evidence are explicitly simulated. No real repository edits or test claims are fabricated.

## What is still needed

1. Teammate 4 must push the implementation to `feature/repository-evidence` (or identify a different branch containing it). Its current remote tip is documentation only. Required pieces include dirty-baseline capture, Git/worktree identity, external-change handling, immutable code changes and observed evidence, supported provider write/review policies, and the final 90-second live/demo script.
2. Integrate that guard/policy into server composition with `createLiveAdapters`; maintain fail-closed behavior until it passes its tests. Do not replace it with a no-op guard just to enable the UI switch.
3. Available Claude quota (or an explicitly configured supported API key) is needed for a fresh Claude→Codex→Claude live smoke and real implement→review→revise validation. Codex still needs validation through the integrated engine after Claude is available.

No additional credentials are needed to use or demonstrate the integrated simulated browser workflow now.

## Startup

```sh
git switch main
git pull --ff-only
npm ci
cp .env.example .env
npm run build
npm start
```

Open http://127.0.0.1:4317. Create a simulated room and address Claude; answer Codex's question to continue the fixture. `npm run demo` performs the same sequence through the API. `npm run check`, `npm run test:integration`, and `npm run test:browser` rerun the validations. Default live mode remains off.
