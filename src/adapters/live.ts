import { join } from 'node:path';
import type { AdapterInput, Adapters, AgentAdapter, AgentId } from '../contracts.js';
import { createClaudeAdapter } from './claude.js';
import type { ClaudeAdapterOptions } from './claude.js';
import { createCodexAdapter } from './codex.js';
import type { CodexAdapterOptions } from './codex.js';
import { readOnlyPolicy } from './provider-permissions.js';
import type { PolicyResolver } from './provider-permissions.js';
import { LiveDisabledError } from './provider-protocol.js';

export interface LiveAdapterConfig {
  /** Explicit opt-in (COMMONTHREAD_LIVE=1). When false every live turn fails closed before invoking a provider. */
  enabled: boolean;
  /** Parent directory for empty per-room scratch workspaces used by rooms without a repository. */
  scratchRoot: string;
  /**
   * Execution policy. Defaults to read-only. Write access must come from a resolver provided by the
   * repository-evidence integration once its RepositoryGuard is registered with the engine.
   */
  policy?: PolicyResolver;
  claude?: Omit<ClaudeAdapterOptions, 'policy'>;
  codex?: Omit<CodexAdapterOptions, 'policy'>;
}

export interface LiveCapabilities {
  enabled: boolean;
  /** Whether a non-default (possibly write-capable) policy was supplied. */
  customPolicy: boolean;
  providers: Record<AgentId, { sdk: string; model: string | null }>;
}

const positiveNumber = (value: string | undefined) => {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Read live configuration from env. Never reads or forwards credentials; the SDKs use their own supported login. */
export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveAdapterConfig {
  const maxBudgetUsd = positiveNumber(env.COMMONTHREAD_CLAUDE_MAX_BUDGET_USD);
  const maxProviderTurns = positiveNumber(env.COMMONTHREAD_CLAUDE_MAX_TURNS);
  return {
    enabled: env.COMMONTHREAD_LIVE === '1',
    scratchRoot: join(env.COMMONTHREAD_DATA_DIR || '.commonthread', 'workspaces'),
    claude: {
      ...(env.COMMONTHREAD_CLAUDE_MODEL ? { model: env.COMMONTHREAD_CLAUDE_MODEL } : {}),
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      ...(maxProviderTurns !== undefined ? { maxProviderTurns: Math.floor(maxProviderTurns) } : {}),
    },
    codex: env.COMMONTHREAD_CODEX_MODEL ? { model: env.COMMONTHREAD_CODEX_MODEL } : {},
  };
}

function gated(agent: AgentId, enabled: boolean, inner: () => AgentAdapter): AgentAdapter {
  let adapter: AgentAdapter | undefined;
  return {
    async execute(input: AdapterInput) {
      if (!enabled) throw new LiveDisabledError('Live providers are disabled. Set COMMONTHREAD_LIVE=1 after configuring provider login (see docs/providers.md).');
      if (input.room.mode !== 'live') throw new LiveDisabledError('Live adapters only run in live rooms; demo rooms use the simulated adapters.');
      if (input.turn.agent !== agent) throw new LiveDisabledError(`The ${agent} adapter cannot run a ${input.turn.agent} turn.`);
      adapter ??= inner();
      return adapter.execute(input);
    },
  };
}

/** One live adapter per agent. SDK clients are created lazily, on the first permitted live turn. */
export function createLiveAdapters(config: LiveAdapterConfig): Adapters {
  const policy = config.policy ?? readOnlyPolicy(config.scratchRoot);
  return {
    claude: gated('claude', config.enabled, () => createClaudeAdapter({ ...config.claude, policy })),
    codex: gated('codex', config.enabled, () => createCodexAdapter({ ...config.codex, policy })),
  };
}

/** Safe-to-display capability summary for `/api/bootstrap`; contains no credentials or provider metadata. */
export function liveCapabilities(config: LiveAdapterConfig): LiveCapabilities {
  return {
    enabled: config.enabled,
    customPolicy: config.policy !== undefined,
    providers: {
      claude: { sdk: '@anthropic-ai/claude-agent-sdk', model: config.claude?.model ?? null },
      codex: { sdk: '@openai/codex-sdk', model: config.codex?.model ?? null },
    },
  };
}
