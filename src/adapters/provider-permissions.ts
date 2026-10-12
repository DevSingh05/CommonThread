import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AdapterInput } from '../contracts.js';

/**
 * Execution policy for one provider turn. Defaults are fail-closed: read-only, no shell,
 * no network. Write access must be granted explicitly by a resolver supplied once the
 * repository guard is registered.
 */
export type AccessMode = 'read_only' | 'workspace_write';
export interface ExecutionPolicy {
  /** Absolute working directory the provider runs in. */
  cwd: string;
  access: AccessMode;
  /** True when `cwd` is a CommonThread scratch directory rather than a user repository. */
  scratch: boolean;
}
export type PolicyResolver = (input: AdapterInput) => ExecutionPolicy | Promise<ExecutionPolicy>;

/** Read-only policy: the room's repository if it has one, otherwise an empty per-room scratch dir. */
export function readOnlyPolicy(scratchRoot: string): PolicyResolver {
  return ({ room }) => {
    if (room.repositoryPath) return { cwd: resolve(room.repositoryPath), access: 'read_only', scratch: false };
    const cwd = join(resolve(scratchRoot), room.id);
    mkdirSync(cwd, { recursive: true });
    return { cwd, access: 'read_only', scratch: true };
  };
}

/** Resolve symlinks of the deepest existing ancestor so a link cannot point outside the root. */
function realish(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]/, ''));
    current = parent;
  }
  let base: string;
  try { base = realpathSync.native(current); } catch { base = current; }
  return rest.length ? join(base, ...rest) : base;
}

export function isInside(root: string, candidate: string): boolean {
  const rootReal = realish(root);
  const target = realish(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const WRITE_TOOLS = ['Edit', 'Write'] as const;
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Built-in Claude Code tools exposed for a policy. Bash, web and subagent tools are never exposed. */
export function claudeToolsFor(policy: ExecutionPolicy): string[] {
  return policy.access === 'workspace_write' ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/**
 * Decide a Claude tool request. In-process CommonThread tools (`sdkTool`) are always allowed;
 * built-in tools must be in the policy and any path argument must stay inside `cwd`.
 */
export function decideClaudeTool(policy: ExecutionPolicy, toolName: string, input: Record<string, unknown>, sdkTool: boolean): ToolDecision {
  if (sdkTool) return { allow: true };
  if (!claudeToolsFor(policy).includes(toolName)) {
    return { allow: false, reason: `CommonThread policy (${policy.access}) does not allow tool "${toolName}". Ask the human via request_user_input if you need it.` };
  }
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0 && !isInside(policy.cwd, value)) {
      return { allow: false, reason: `Path "${value}" is outside the room workspace.` };
    }
  }
  return { allow: true };
}

/** Codex thread options derived from policy: OS sandbox, no approvals (denials fail closed), no network. */
export function codexThreadOptionsFor(policy: ExecutionPolicy) {
  return {
    workingDirectory: policy.cwd,
    sandboxMode: policy.access === 'workspace_write' ? 'workspace-write' as const : 'read-only' as const,
    approvalPolicy: 'never' as const,
    networkAccessEnabled: false,
    webSearchMode: 'disabled' as const,
    skipGitRepoCheck: policy.scratch,
  };
}
