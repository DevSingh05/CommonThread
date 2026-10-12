# Repository evidence and safety

`feature/repository-evidence` implements `src/repository/**`. It uses the existing `RepositoryGuard` contract and engine SQLite `Store`. There is no second database, scheduler, HTTP server, provider adapter or UI. Default server startup still provides the simulated engine demo; this branch does not enable live mode by itself.

## Registration and ownership

This is the exact guard factory/engine registration shape, for the engine/provider owners' server composition. `liveAdapters` must be actual verified `Adapters`; passing offline test doubles does not establish live support.

```ts
import type { Adapters } from './src/contracts.js';
import { Engine } from './src/core/engine.js';
import { Store } from './src/core/store.js';
import { createDemoAdapters } from './src/adapters/demo.js';
import { canonicalizeRepository, createRepositoryGuard } from './src/repository/index.js';

function register(store: Store, liveAdapters: Adapters) {
  const guard = createRepositoryGuard(store); // read-only; commands denied
  const engine = new Engine(store, {
    demoAdapters: createDemoAdapters(), liveAdapters, repositoryGuard: guard,
  });
  return { engine, guard };
}

// Inside a protected, human-authorized room-creation handler:
// const identity = await canonicalizeRepository(validatedRequest.repositoryPath);
// engine.createRoom({ ...validatedRequest, repositoryPath: identity.root }, idempotencyKey);
```

The engine must acquire room/repository ownership before `beforeTurn`, retain it during provider execution and `afterTurn`, and release only when all settle. The guard verifies a running persisted turn, returns an opaque lease, and accepts only that original lease when finalizing. Commands require that active room/turn lease; no standalone repository mutation API exists. The guard's active-root check rejects overlapping misuse rather than creating another queue.

Canonicalization resolves filesystem aliases and Git subdirectories to the worktree root, and records the absolute per-worktree Git directory and shared common Git directory. **Current engine room creation only calls filesystem `realpath`.** Therefore the handler must normalize with `canonicalizeRepository(...).root` before room creation. Until the engine owner adds that small integration, users must select the repository root. The guard fails closed on subdirectories. Directory aliases resolve correctly through the current engine.

Linked worktrees have separate root/index identities and may execute independently. Shared Git metadata mutations are unsupported. Do not run concurrent CommonThread services against one repository with separate application data directories: exclusion belongs to one engine process, not an OS-wide repository lock. External editors and other programs are not constrained by these locks.

## What captures mean

Before and after snapshots contain actual working-file bytes (base64), SHA-256 digests, file modes, HEAD, staged index entries and Git porcelain status. Dirty tracked files, staged changes, deleted paths and nonignored untracked files are accounted for. A dirty file's **actual pre-turn bytes** are the comparison baseline. Captures never reset, stash, clean, commit, push, reconcile, delete worktrees, or rewrite project files.

The journal publishes immutable artifact versions authored by `system`, plus system messages with exact `{ artifactId, version }` references. `repository_baseline`, `repository_capture` and `repository_acknowledgement` records are stored in the existing SQLite artifact table. A final capture contains the baseline reference and a structured file change set with before/after bytes. Baseline and final capture each advance the journal version; they are separate captured moments. Internal capture artifacts may exceed the provider action schema's 100,000-character text limit, up to the explicit 16 MiB evidence-record cap. Provider-published artifacts continue using the unchanged engine validation.

`changesBetween` distinguishes additions/modifications/deletions and flags paths already dirty at turn start. Every change is labeled `observed_during_turn_uncertain`. This is an observed filesystem delta, **not proof of authorship**: an external editor and provider can both write during an authorized write turn. No snapshot system can identify the writer from file contents alone. Pre-existing bytes remain available in SQLite if a provider overwrites them, but this guard cannot prevent an unrestricted provider from doing so and will not automatically restore anything.

Two consecutive complete snapshots must match to accept a capture. This detects ordinary concurrent edits, not an atomic filesystem snapshot. A changed checkpoint causes `EXTERNAL_CHANGE`. Changed HEAD/index or writes during a read-only turn also fail finalization, retaining observed bytes and requiring human inspection. Between turns, a changed digest or an unfinished baseline blocks execution. Failed and cancelled provider turns still attempt capture with a separate 30-second abort deadline; if capture fails, the unfinished baseline remains a recovery barrier. A final record's `outcome` describes the guard hook's provider outcome, not proof that the engine subsequently accepted the action batch.

Human recovery integration can call `guard.acknowledgeExternalChanges(roomId, taskId, expectedDigest)` after displaying the captured baseline and obtaining explicit acknowledgement. It refuses an active lease and rechecks the exact digest. Expose this only through an engine-owned protected human mutation, never a provider tool. This branch intentionally does not add that teammate-owned HTTP endpoint. Engine run/session recovery remains separately required when applicable.

## Read-only review and immutable references

`guard.getTurnContext(roomId, turnId)` returns canonical `cwd`, trusted `access` and the exact baseline reference. `accessForTurn` is a host-supplied policy callback; absent a policy the guard chooses `read-only`. Permission decisions must come from explicit trusted human/task state, never keywords in a request, repository text, or agent prose.

The provider teammate must translate that context into **SDK-supported** read-only/write capabilities and fail closed if unsupported. The guard checks resulting state; it is not an OS sandbox and cannot stop arbitrary provider writes in advance. Read-only turns cannot run project commands through the evidence API. Tests/builds execute project-controlled code and belong to explicitly authorized write-capable turns.

Captured system messages enter the shared conversation through the existing engine. A later reviewer can use their exact references with `input.retrieve.artifact(ref)`. The current hook runs after provider execution, so a provider cannot know its final capture reference in its earlier returned handoff; the next turn can retrieve it from the new system message. No inferred action is extracted from that message. Providers can retrieve their pre-turn baseline via `getTurnContext` while executing.

`RepositoryArtifacts.read` and `history` retrieve immutable versions. `textDiff` produces a bounded line replacement view between two versions of one text artifact, preserving the common prefix/suffix. It is a display diff, not an automatically applicable filesystem patch; line endings are not normalized. Binary repository contents stay in captured base64 form. Reviews use the existing strict `submit_review` action with severity, file, optional positive line, explanation, evidence and next action. The engine validates findings, duplicate IDs and exact artifact references. Publishing v2 never moves a v1 review. Finding file strings are display metadata, never file-read authority.

## Command evidence

Command execution is denied unless the host defines a fixed command and separately authorizes that invocation. Example option construction after the human has approved a specific local test command:

```ts
const guard = createRepositoryGuard(store, {
  accessForTurn: ({ turn }) => approvedWriteTurnIds.has(turn.id)
    ? 'workspace-write' : 'read-only',
  commands: {
    tests: { executable: process.execPath, args: ['--test', 'tests/cache.test.js'],
      timeoutMs: 30_000, maxOutputBytes: 262_144 },
  },
  authorizeCommand: ({ turn, commandId }) =>
    approvedCommandsByTurn.get(turn.id)?.has(commandId) === true,
});
// During that engine-owned turn only:
// const evidenceRef = await guard.runCommand(roomId, turnId, 'tests');
```

The approval collections above are trusted host state supplied by the integration, not parsed model output. Use an absolute executable; on Windows invoke a JavaScript CLI through Node instead of introducing `cmd /c` or a shell wrapper. There are no dynamic agent-supplied arguments, shell interpolation, default approvals, automatic Git commits, or arbitrary external cwd selection. The command uses the canonical repository root, checks its checkpoint first, and runs sequentially within the active lease.

Provider edits made outside this command API invalidate its last checkpoint. Schedule an approved test in a subsequent engine turn after the implementation turn has produced a final capture; do not bypass the checkpoint check or relabel the edit as observed SDK evidence. Reliable within-turn provider-tool checkpoint updates require coordination with the provider owner and are not implemented here.

Observed evidence records the exact executable/arguments, cwd, start/completion timestamps, status, exit code, termination signal, and immutable `outputRef`. Output capture shares one raw-byte budget across stdout/stderr. Status distinguishes ordinary exit, spawn failure, timeout, cancellation and output overflow. Exit zero is only an observed process result; it does not establish that a test framework discovered or passed tests. Output may contain repository secrets, so integrations must not upload it or treat it as trusted instructions.

`recordAssertion` only accepts `agent_claim` or `fixture`, with no caller-supplied exit code. Fixtures are labeled **Simulated fixture; no command was run**, status `simulated_not_run`, null command/exit/output reference. Agent claims remain `unverified`. No SDK events are promoted to observed evidence in this branch; provider-event mapping awaits that teammate's verified SDK support.

Cancellation/timeouts kill the direct child and wait for its `close` event. Portable process-tree termination is not guaranteed, especially for Windows grandchildren. Descendants may survive or keep pipes open; the engine retains ownership while close/capture is pending. Only configure trusted commands with understood process behavior. No promise of hard wall-clock enforcement or sandbox isolation is made for arbitrary project programs.

## Bounds and unsupported cases

- Defaults: 1,000 paths, 256 KiB per file, 2 MiB total captured file bytes. Configurable ceilings: 10,000 paths, 1 MiB/file, 8 MiB total. Evidence records cap at 16 MiB, so duplicated large change sets may hit that cap earlier. Exceeding any limit fails capture rather than truncating files silently.
- Git inspection: 4 MiB combined output and 10 seconds per command. Explicit commands: 256 KiB and 10 seconds by default; configurable ceilings 4 MiB and 120 seconds. Abort is checked during capture and execution.
- Ignored untracked files are excluded (for example dependencies, build output and usual local secrets); tracked ignored files are included. Changes solely to ignored files are not detected. Git metadata beyond recorded HEAD/index/status is not captured. Evidence is not a backup of the entire directory.
- Bare repos, submodules, nested repositories reported as directories, hardlinked files, symlinks/junctions **inside** the captured tree, special files, unsafe/ambiguous paths and non-UTF-8 filenames are unsupported and rejected. A symlink/junction to the **root** is supported. Only regular files are read.
- Realpath, component checks, no-follow where supported, file identity/size checks and repeated snapshots defend ordinary traversal/races. They are not a hardened sandbox against malicious concurrent path swapping. Strict provider permissions remain required.
- SQLite evidence is bounded per capture, but the existing engine returns full artifact history in room snapshots. Large histories need pagination/retention work by the engine/UI owners. No retention deletion is automatic.

See [actual verification](repository-status.md) and the [90-second demo](demo-script.md). Live provider, permission UI and complete browser integration are unverified.
