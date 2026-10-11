# Repository evidence implementation status

Branch: `feature/repository-evidence`. Engine foundation `1a316cd` was already merged; fetching and fast-forward checking the engine branch required no changes. Only repository-owned implementation, tests and handoff documentation are being added.

## Original validation pass: bounded repository inspection

Implemented canonical Git worktree identities, actual dirty/untracked working-file captures, index/HEAD/status recording, immutable in-memory comparisons, path containment checks, and shell-free bounded process execution. Captures reject unsupported files and limits rather than silently producing partial evidence.

Actual checks on Windows, Node 24.13.1, npm 11.8.0:

- Typecheck, lint and build passed.
- Repository acceptance: 7/7 tests passed, including directory-junction aliases and linked worktrees.
- Full suite: 47 passed, 1 failed. Existing `tests/engine.test.ts:235` uses `symlinkSync` without a directory-junction type; this environment denies that operation with `EPERM`. Teammate-owned test left unchanged.
- Node is below the documented 24.14+ requirement. Results do not establish validation on the supported version.
- `.venv` was created with Python 3.13.7 as requested, before any installation. No libraries were installed; existing project-local Node dependencies suffice. The virtual environment's own ignore file excludes its contents.

This is offline repository infrastructure, not verified live provider behavior or completed UI integration.

## Original validation pass: durable guard and evidence

Added `createRepositoryGuard`, engine-owned turn leases, before/after journal versions, digest-pinned human acknowledgement, immutable command/output references, provenance-checked assertions, read-only mutation detection, and artifact history/text comparisons. Uses existing SQLite tables and strict engine review schemas. No new dependencies or changes to engine/provider/UI implementations.

Actual checks: typecheck, lint and build passed; repository acceptance passed **18/18** tests (39.46 seconds). The guard tests use longer per-suite deadlines for repeated real Git subprocess workflows on Windows. An initial strict-reference test error was corrected; a later intermittent timeout passed in isolation and in the complete acceptance rerun. These tests run real local Git/Node commands in disposable directories; provider executions in engine integration tests are offline doubles, not real SDK calls.

Coverage includes dirty/staged/untracked preservation, root/alias/worktree identity, unsafe paths and capture limits, pre/final capture exception cleanup, cancellation with a running process, between-turn and checkpoint changes, read-only/index violations, explicit command denial/authorization, output references and provenance, SQLite reopen persistence, two-room engine serialization after provider failure, exact-version reviews and malformed findings.

## Final verification and handoff — October 11, 2026

| Check | Actual outcome |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npx vitest run tests/repository-guard.test.ts tests/repository-snapshot.test.ts` | 18/18 passed |
| `npm test` | 58 passed, 1 failed; 43.19 seconds. Only failure is the pre-existing Windows `symlinkSync` permission issue at `tests/engine.test.ts:235`. |
| `npm run build` | Passed; repository modules emitted under `dist/server/repository/` |
| Built server startup | `node dist/server/server/main.js` with a temporary data directory and ephemeral loopback port; health HTTP 200, live capability false |
| Simulated API demo | `node --import tsx scripts/demo.ts` against that server completed: 5 turns, 2 artifact versions, 2 reviews; explicitly simulated, no provider calls/edits/tests from the fixture |
| `git diff --check` | Passed |

The smoke-test server was stopped and its temporary database directory removed. Automatic approval review later rejected cleanup of two different temporary folders left by earlier timed-out tests with “blocked by policy”; those folders were left in the OS temp directory.

Handoff: [registration, limits and permission requirements](repository-safety.md), [90-second simulated/credentialed demo and acceptance checklist](demo-script.md). `notes.md` records the small integration requests for the engine/provider owners. No SDK authentication or external account access was needed. No dependencies were installed, no shared application contracts were changed, and no teammate-owned implementation was edited.

Remaining integration: canonical-root normalization in the protected room-creation handler; protected human acknowledgement/command permissions; provider-supported read-only capability mapping; UI presentation of captured versions/output references; real credentialed workflow and browser verification. Commands after out-of-band provider edits must run in a subsequent turn with a newly captured baseline. Cross-process repository locking, ignored-file capture and adversarial filesystem/process isolation are not provided. See the safety document for exact boundaries.

Commits use the configured human Git identity. At the user's request, the local implementation history was reorganized into eight coherent milestones, with author and committer dates spread over the preceding three hours at roughly 25-minute intervals. These chosen dates are not a record of actual execution times. Commits remain local; no push or PR was requested.

## Reorganized implementation history

The original three local commits were split without changing final application code or tests. A backup branch retains the original history. The eight milestones introduce bounded processes, repository snapshots, SQLite artifact persistence, turn guards, authorized command evidence, versioned review support, safety handoff, and demo/acceptance documentation in dependency order.

Each of the six code revisions passed typecheck, lint, build and the repository tests available at that revision (2, 7, 7, 13, 16 and 18 tests respectively). The SQLite-artifact milestone also passed a direct persistence/version-isolation smoke check. The final revision retains the original validation outcomes and limitations above.
