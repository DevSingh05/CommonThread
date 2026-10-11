# Provider adapters (Claude + Codex)

Owner: Teammate 2, branch `feature/provider-adapters`. Progress/continuation log: [providers-status.md](providers-status.md).

## Versions and sources

| Provider | Package (exact) | Underlying runtime | Verified against |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk@0.3.296` | Claude Code executable bundled/managed by the SDK | Installed `sdk.d.ts` types; [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) |
| Codex | `@openai/codex-sdk@0.162.1` | `@openai/codex@0.162.1` CLI (`codex exec` JSONL), pulled in as a dependency | Installed `dist/index.d.ts` types and package README; [source](https://github.com/openai/codex/tree/main/sdk/typescript) |

Every method/option used below was checked in the installed type definitions. Nothing was copied from blogs.

## Files

- `src/adapters/provider-protocol.ts` — prompt serialization with explicit trust levels, provider-neutral strict JSON schema for the action batch, `normalizeActions` (null-stripping + contract `actionBatchSchema` validation), usage mapping, error sanitizing, error classes.
- `src/adapters/provider-permissions.ts` — `ExecutionPolicy` (`read_only` | `workspace_write`), default `readOnlyPolicy`, Claude tool decisions with symlink-safe path containment, Codex sandbox options.
- `src/adapters/claude.ts` — `createClaudeAdapter`.
- `src/adapters/codex.ts` — `createCodexAdapter`.
- `src/adapters/live.ts` — `createLiveAdapters`, `liveConfigFromEnv`, `liveCapabilities`.
- `tests/provider-*.test.ts` — offline tests with mocked SDK boundaries.
- `scripts/provider-smoke.ts` — opt-in credentialed smoke (`npm run smoke:providers`).

## Capability matrix (what each adapter actually uses)

| Capability | Claude Agent SDK | Codex SDK |
| --- | --- | --- |
| New session | `query({ prompt, options })`; session id from `system/init` `session_id` | `codex.startThread(threadOptions)`; id from `thread.started` / `thread.id` |
| Resume | `options.resume = providerSessionId`; if init reports a different `session_id`, or the call fails before init → `SessionResumeError` (no silent new session) | `codex.resumeThread(id, threadOptions)`; mismatched `thread.started` id, or failure before `turn.started` → `SessionResumeError` |
| Structured output | `outputFormat: { type: 'json_schema', schema }` → `result.structured_output` | `runStreamed(prompt, { outputSchema })` → final `agent_message` text (JSON) |
| Custom tools | In-process MCP server (`createSdkMcpServer` + `tool`) named `commonthread` with read-only `get_message`, `get_task`, `get_artifact`, scoped to the room | **None.** The SDK has no in-process tool API. Referenced artifacts are inlined (bounded) into the prompt instead |
| Streaming public output | `includePartialMessages`; only top-level `text_delta` is emitted as `text`; `thinking_delta` is never emitted; `tool_use` blocks → `activity` summaries | Only `activity` summaries for command/file/MCP/web-search/error items. `reasoning` items are never emitted; `agent_message` is the JSON result and is not streamed |
| Cancellation | Turn `AbortSignal` → SDK `abortController`. `ProviderCancelledError.confirmed=true` only when SDK threw `AbortError` | Turn `AbortSignal` → `TurnOptions.signal`. Always reported `confirmed=false` (the SDK gives no terminal confirmation) |
| Permissions | `tools` limited to policy (`Read`,`Grep`,`Glob` [+`Edit`,`Write`]); `permissionMode: 'default'` + `canUseTool` denies anything else and any path outside `cwd` (symlinks resolved); denials surfaced as `activity`. `settingSources: []`, `strictMcpConfig: true` so user/project settings and MCP servers cannot widen access | `sandboxMode` `read-only` / `workspace-write`, `approvalPolicy: 'never'` (no interactive approval surface exists in the SDK, so anything outside the sandbox fails closed), `networkAccessEnabled: false`, `webSearchMode: 'disabled'` |
| Usage | `result.usage.input_tokens/output_tokens` → `reported`; else `unavailable`. Cost (`total_cost_usd`) is **not** surfaced (it is an SDK estimate, and contracts forbid invented pricing) | `turn.completed.usage.input_tokens/output_tokens` → `reported`; else `unavailable` |
| Limits | `maxTurns` (default 24, `COMMONTHREAD_CLAUDE_MAX_TURNS`), optional `maxBudgetUsd` | Engine turn timeout via AbortSignal; Codex has no per-turn max-steps option in this SDK version |

Bash is never exposed to Claude. Shell execution for Codex happens only inside its OS sandbox; in `read-only` mode commands can read but not write.

## Prompt and trust model

Each turn sends one user prompt (never prior assistant messages from another actor). Sections, in order: trusted system instructions (from the engine's `context.instructions` plus the output protocol), room goal, active task/request, **human guidance** (trusted), then new room messages, referenced messages, proposals, questions and artifacts as **JSON-encoded, explicitly untrusted data** with each entry's original `author` and `id`. The model must answer with `{ "actions": [...] }`; adapters never parse prose into actions.

The output schema is written for OpenAI strict mode (every property required, optional values `null`, `additionalProperties: false`), so the same schema works for both providers. `normalizeActions` strips nulls, assigns fresh UUIDs to review findings whose `id` is null, and validates against `actionBatchSchema` from `src/contracts.ts`. Any author/actor field is rejected by the strict contract schema; the engine derives authorship from the turn.

## Errors (all `AppError` subclasses)

| Error | Code | Meaning / retry |
| --- | --- | --- |
| `LiveDisabledError` | `LIVE_DISABLED` | Live not enabled, demo room, or agent mismatch. Provider never invoked |
| `SessionResumeError` | `SESSION_RESUME_FAILED` | Stored session could not be resumed. Use the engine's explicit `fresh_session` control |
| `ProviderOutputError` | `PROVIDER_OUTPUT_INVALID` | Provider ran but output was not a valid batch. **Not** safe to auto-retry |
| `ProviderExecutionError` | `PROVIDER_FAILED` | Provider failed after invocation (error result, max turns, SDK crash). Not safe to auto-retry |
| `ProviderCancelledError` | `PROVIDER_CANCELLED` | AbortSignal fired; `confirmed` says whether the SDK reported an abort. Never proof remote work stopped |

Adapters never throw `BeforeInvocationError`: once `query()`/`runStreamed()` is called we cannot prove the provider was not reached. Error text is bounded and passed through `sanitizeError` (masks `sk-…`, bearer tokens, `api_key=`/`token=` values).

## Setup

```bash
npm install
```

Login (supported local CLI login; CommonThread never reads or stores credentials):

```bash
claude
```

(run `/login` inside Claude Code once; alternatively export `ANTHROPIC_API_KEY` in your shell)

```bash
npx codex login
```

(ChatGPT sign-in; alternatively export `CODEX_API_KEY`)

Enable live mode for the server process only after the engine registers the adapters (see below):

```bash
COMMONTHREAD_LIVE=1 npm run dev
```

Other env vars (all optional, see `.env.example`): `COMMONTHREAD_CLAUDE_MODEL`, `COMMONTHREAD_CODEX_MODEL`, `COMMONTHREAD_CLAUDE_MAX_BUDGET_USD`, `COMMONTHREAD_CLAUDE_MAX_TURNS`, `COMMONTHREAD_DATA_DIR` (scratch workspaces go to `<data dir>/workspaces/<roomId>` for rooms without a repository).

## Engine registration (coordinate with Teammate 1)

The engine branch currently has contracts/store/context only; the dispatcher and server composition have not landed. When they do, the server composition needs a small patch along these lines (engine owner applies it):

```ts
import { createLiveAdapters, liveCapabilities, liveConfigFromEnv } from '../adapters/live.js';

const liveConfig = liveConfigFromEnv();
const liveAdapters = createLiveAdapters({
  ...liveConfig,
  // Supplied by teammate 4 once RepositoryGuard is registered; omit to stay read-only.
  // policy: repositoryPolicy,
});
// Choose adapters by room.mode: demo rooms → demo adapters, live rooms → liveAdapters.
// Expose liveCapabilities(liveConfig) in /api/bootstrap so the UI can disable live when off.
```

`createLiveAdapters` returns `Record<'claude'|'codex', AgentAdapter>`. Each adapter refuses demo rooms and refuses to run when `enabled` is false, so registering it is fail-closed by default.

## Repository integration (coordinate with Teammate 4)

Write access is granted **only** through a `PolicyResolver` (`(input) => { cwd, access, scratch }`) passed as `policy`. The default resolver is read-only for every turn. Teammate 4 should supply a resolver that returns `workspace_write` for implement turns on a guarded repository and `read_only` for review turns. Limits to document honestly:

- Claude path checks cover `file_path`/`path`/`notebook_path` arguments of built-in tools; Bash is not exposed at all.
- Codex enforcement is Codex's OS sandbox (`read-only` / `workspace-write`), not CommonThread code. On Windows the sandbox support level depends on the Codex CLI build.
- Observed command results for evidence: Codex `command_execution` items carry `command`, `exit_code`, `aggregated_output` and could be recorded as `observed` evidence; that wiring belongs to the repository/evidence branch. Today only an activity summary is emitted.

## Tests

```bash
npm test
```

Offline (mocked SDK boundaries) coverage: prompt trust labeling and injection containment, strict-schema compatibility, malformed output (prose, missing actions, empty batch, author impersonation, bad recipient, review without findings), credential redaction, policy denials (Bash, web, writes in read-only, outside paths, symlink escape), Codex sandbox mapping, Claude new/resume/resume-mismatch/resume-failure, streaming filters (no thinking/reasoning), cancellation, permission denial via `canUseTool`, usage absence, Codex new/resume/mismatch/failure, two-way Claude → Codex → Claude handoff extraction, live gating and env parsing.

Credentialed smoke (makes real, billable requests; opt-in):

```bash
COMMONTHREAD_LIVE_SMOKE=1 npm run smoke:providers
```

It drives Claude → Codex → Claude directly through the live adapters with an in-memory context (not the engine dispatcher) and checks each step returned the expected structured handoff/completion, printing provider session IDs and reported usage.

## Live verification status

See [providers-status.md](providers-status.md) for the latest recorded live outcome. Until a recorded successful smoke run exists there, **live behavior is unverified**.

## Known limitations

- Codex has no custom-tool hook in this SDK, so it cannot fetch arbitrary message/task/artifact IDs on demand; it gets bounded inlined context only.
- Codex cancellation and Claude cancellation are best-effort; neither proves remote side effects stopped.
- No interactive permission prompts reach the human yet: denials fail closed and are surfaced as activity. An additive permission lifecycle contract (pending request → human decision) would need to be agreed with the engine owner.
- Claude's in-process MCP tool trust is keyed on `mcpServer.source === 'sdk'`; on older CLIs that omit this field, retrieval tools are still pre-approved via `allowedTools`.
