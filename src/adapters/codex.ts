import { Codex } from '@openai/codex-sdk';
import type { CodexOptions, Input, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import type { AdapterInput, AdapterResult, AgentAdapter, Usage } from '../contracts.js';
import { SessionResumeError } from '../core/errors.js';
import { codexThreadOptionsFor } from './provider-permissions.js';
import type { PolicyResolver } from './provider-permissions.js';
import {
  ProviderCancelledError, ProviderExecutionError, ProviderOutputError, actionOutputJsonSchema,
  buildPrompt, normalizeActions, reportedUsage, sanitizeError,
} from './provider-protocol.js';

/** The SDK boundary (subset of `Codex`/`Thread` actually used), injectable for offline tests. */
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}
export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexAdapterOptions {
  policy: PolicyResolver;
  model?: string;
  /** Passed to `new Codex(...)`. Leave apiKey unset to use the supported `codex login` credentials. */
  codexOptions?: CodexOptions;
  client?: CodexClientLike;
}

function activityFor(item: ThreadItem, phase: 'started' | 'completed'): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return phase === 'started'
        ? `Running: ${item.command.slice(0, 200)}`
        : `Command ${item.status}${item.exit_code !== undefined ? ` (exit ${item.exit_code})` : ''}: ${item.command.slice(0, 200)}`;
    case 'file_change':
      return phase === 'completed' ? `File change ${item.status}: ${item.changes.map(change => `${change.kind} ${change.path}`).join(', ').slice(0, 300)}` : undefined;
    case 'mcp_tool_call':
      return `Tool ${phase}: ${item.server}.${item.tool}`;
    case 'web_search':
      return phase === 'started' ? `Web search: ${item.query.slice(0, 200)}` : undefined;
    case 'error':
      return `Codex reported: ${sanitizeError(item.message)}`;
    // reasoning is never streamed; agent_message carries the structured JSON result; todo lists are internal.
    default:
      return undefined;
  }
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  let client = options.client;
  const getClient = () => (client ??= new Codex(options.codexOptions ?? {}));
  return {
    async execute(input: AdapterInput): Promise<AdapterResult> {
      if (input.turn.agent !== 'codex') throw new ProviderExecutionError('Codex adapter received a turn for another agent.', 'ADAPTER_MISMATCH');
      if (input.signal.aborted) throw new ProviderCancelledError(false);
      const policy = await options.policy(input);
      const threadOptions: ThreadOptions = { ...codexThreadOptionsFor(policy), ...(options.model ? { model: options.model } : {}) };
      const resumeId = input.session.providerSessionId;
      const thread = resumeId ? getClient().resumeThread(resumeId, threadOptions) : getClient().startThread(threadOptions);

      let threadId: string | undefined = resumeId;
      let finalResponse: string | undefined;
      let usage: Usage = { kind: 'unavailable' };
      let failure: string | undefined;
      let started = false;
      try {
        const { events } = await thread.runStreamed(buildPrompt(input, { retrievalTools: false }), { outputSchema: actionOutputJsonSchema, signal: input.signal });
        for await (const event of events) {
          if (event.type === 'thread.started') {
            if (resumeId && event.thread_id !== resumeId) throw new SessionResumeError();
            threadId = event.thread_id;
          } else if (event.type === 'turn.started') {
            started = true;
          } else if (event.type === 'item.started' || event.type === 'item.completed') {
            const text = activityFor(event.item, event.type === 'item.started' ? 'started' : 'completed');
            if (text) input.emit({ type: 'activity', text });
            if (event.type === 'item.completed' && event.item.type === 'agent_message') finalResponse = event.item.text;
          } else if (event.type === 'turn.completed') {
            usage = reportedUsage(event.usage.input_tokens, event.usage.output_tokens);
          } else if (event.type === 'turn.failed') {
            failure = event.error.message;
          } else if (event.type === 'error') {
            failure = event.message;
          }
        }
      } catch (error) {
        if (error instanceof SessionResumeError) throw error;
        if (input.signal.aborted) throw new ProviderCancelledError(false);
        // A resumed thread that never started a turn could not be resumed; do not fall back silently.
        if (resumeId && !started) throw new SessionResumeError();
        throw new ProviderExecutionError(`Codex SDK failed: ${sanitizeError(error)}`);
      }
      if (input.signal.aborted) throw new ProviderCancelledError(false);
      if (failure) {
        if (resumeId && !started) throw new SessionResumeError();
        throw new ProviderExecutionError(`Codex turn failed: ${sanitizeError(failure)}`);
      }
      threadId = thread.id ?? threadId;
      if (finalResponse === undefined) throw new ProviderOutputError('Codex returned no final message.');
      return { actions: normalizeActions(finalResponse), ...(threadId ? { providerSessionId: threadId } : {}), usage };
    },
  };
}
