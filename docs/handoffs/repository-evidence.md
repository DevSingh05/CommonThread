# Teammate 4 — repository coordination and evidence

Branch: `feature/repository-evidence`. Own `src/repository/**`, associated tests, `docs/repository-safety.md`, `docs/demo-script.md`. Merge `origin/feature/conversation-engine` first. Engine owns queue and repository exclusion; do not add an independent scheduler.

## Implement

Inspect the actual `RepositoryGuard` type in contracts. Implement canonical repository validation, before/after-turn baseline capture, immutable change sets, safe command evidence and external-change checks. Resolve symlinks and Git worktree identity so two rooms cannot write the same repo under different aliases. Engine acquires ownership before your hooks. Require any orchestrator mutation to use the same ownership path.

Capture the actual pre-turn file state including dirty tracked and untracked changes; a plain `git diff HEAD` cannot attribute new changes correctly when a repo was dirty. Preserve all pre-existing edits. Capture versioned changes for review, and distinguish task-produced modifications from pre-existing/uncertain changes. Detect external changes and refuse destructive reconciliation. Never auto reset/stash/clean/commit/push/delete worktrees. The user's instruction to commit the application source is not standing consent for operations in connected repositories.

Bound file sizes, output, paths and command duration. Use spawn/execFile argument arrays with explicit cwd and cancellation. Avoid interpolated shell commands from agent text. Prevent traversal and symlink escapes in any file access the application implements. Repository content and tool output cannot grant orchestration privileges.

Expose immutable captured diff/artifact versions compatible with engine `ArtifactRef`; reviews always reference a captured version. Support text artifact history/diff and structured review findings with severity/file/line/evidence/next action. Server already owns action validation and base-version checks; extend rather than duplicate these.

Evidence must record command, cwd, exit code/status, timestamp, output reference, provenance (`observed`, `agent_claim`, `fixture`). Agent assertions never become observed test results. Fixtures do not run shell commands or claim passing tests. Coordinate with provider teammate to derive reliable observed tool results only from SDK-supported events and preserve provider limitations honestly.

Reviewers should receive supported read-only provider capabilities. Shared app locks do not constrain external editors or guarantee a malicious provider cannot write; document enforcement limits. Local server binds localhost and has request protection, but permission and path validation are still your responsibility at repository boundaries.

## Tests and handoff

Use temporary Git repos: clean/dirty/untracked baselines, external edits mid-turn, symlink aliases, two rooms contending for one repo, exception/cancellation lock release, review against v1 after v2 publication, malformed findings, bounded output, traversal attempts. Never mutate a user's existing repo during tests.

Provide exact guard factory/registration example and explain unsupported cases. Add the final 90-second visible demo script with clearly separate simulated and credentialed paths, and a full acceptance checklist. Run relevant tests/typecheck/lint/build. Do not claim the integrated app is finished until engine/providers/UI are merged and validated.
