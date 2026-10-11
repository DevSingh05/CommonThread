import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import type { ClaudeQuery } from '../src/adapters/claude.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import type { CodexClientLike } from '../src/adapters/codex.js';
import { createLiveAdapters, liveCapabilities, liveConfigFromEnv } from '../src/adapters/live.js';
import { readOnlyPolicy } from '../src/adapters/provider-permissions.js';
import { LiveDisabledError, ProviderCancelledError, ProviderExecutionError, ProviderOutputError } from '../src/adapters/provider-protocol.js';
import { SessionResumeError } from '../src/core/errors.js';
import type { Action } from '../src/contracts.js';
import { TASK_ID, handoffTo, makeInput } from './provider-fixtures.js';

const policy = readOnlyPolicy(join(tmpdir(), 'ct-provider-tests'));
const SESSION = randomUUID();
const msg = (value: unknown) => value as SDKMessage;
const init = (sessionId = SESSION) => msg({ type: 'system', subtype: 'init', session_id: sessionId });
const result = (structured: unknown, extra: Record<string, unknown> = {}) => msg({
  type: 'result', subtype: 'success', is_error: false, session_id: SESSION, structured_output: structured,
  usage: { input_tokens: 120, output_tokens: 30 }, permission_denials: [], ...extra,
});

function fakeClaude(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: ClaudeQuery = params => { calls.push(params); return script(params.options); };
  return { query, calls };
}

describe('Claude adapter (mocked Agent SDK)', () => {
  it('starts a session, streams public text/activity, and returns validated actions with usage', async () => {
    const { query, calls } = fakeClaude(async function* () {
      yield init();
      yield msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } } });
      yield msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the plan.' } } });
      yield msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'plan.md' } }] } });
      yield result(handoffTo('codex'));
    });
    const { input, events } = makeInput('claude');
    const output = await createClaudeAdapter({ policy, query }).execute(input);
    expect(output.providerSessionId).toBe(SESSION);
    expect(output.usage).toEqual({ kind: 'reported', inputTokens: 120, outputTokens: 30 });
    expect((output.actions as Action[]).map(action => action.type)).toEqual(['post_message', 'handoff']);
    expect(events).toEqual([{ type: 'text', text: 'Reading the plan.' }, { type: 'activity', text: 'Tool: Read plan.md' }]);
    const options = calls[0]!.options;
    expect(options.resume).toBeUndefined();
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options.outputFormat?.type).toBe('json_schema');
    expect(options.mcpServers?.commonthread).toBeDefined();
    expect(options.allowedTools).toEqual(['mcp__commonthread__get_message', 'mcp__commonthread__get_task', 'mcp__commonthread__get_artifact']);
  });

  it('resumes the stored session and fails explicitly if the SDK starts a different one', async () => {
    const ok = fakeClaude(async function* () { yield init(); yield result(handoffTo('codex')); });
    await createClaudeAdapter({ policy, query: ok.query }).execute(makeInput('claude', { providerSessionId: SESSION }).input);
    expect(ok.calls[0]!.options.resume).toBe(SESSION);
    const swapped = fakeClaude(async function* () { yield init(randomUUID()); yield result(handoffTo('codex')); });
    await expect(createClaudeAdapter({ policy, query: swapped.query }).execute(makeInput('claude', { providerSessionId: SESSION }).input)).rejects.toBeInstanceOf(SessionResumeError);
  });

  it('maps a resume failure before initialization to SessionResumeError', async () => {
    // eslint-disable-next-line require-yield
    const { query } = fakeClaude(async function* () { throw new Error('No conversation found with session ID'); });
    await expect(createClaudeAdapter({ policy, query }).execute(makeInput('claude', { providerSessionId: SESSION }).input)).rejects.toBeInstanceOf(SessionResumeError);
  });

  it('rejects malformed structured output and error results', async () => {
    const bad = fakeClaude(async function* () { yield init(); yield result({ actions: [{ type: 'post_message', body: 'hi', author: 'human' }] }); });
    await expect(createClaudeAdapter({ policy, query: bad.query }).execute(makeInput('claude').input)).rejects.toBeInstanceOf(ProviderOutputError);
    const none = fakeClaude(async function* () { yield init(); yield result(undefined); });
    await expect(createClaudeAdapter({ policy, query: none.query }).execute(makeInput('claude').input)).rejects.toBeInstanceOf(ProviderOutputError);
    const failed = fakeClaude(async function* () { yield init(); yield msg({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: SESSION, errors: [], usage: {}, permission_denials: [] }); });
    await expect(createClaudeAdapter({ policy, query: failed.query }).execute(makeInput('claude').input)).rejects.toThrow(/error_max_turns/);
  });

  it('reports usage as unavailable when the SDK omits it', async () => {
    const { query } = fakeClaude(async function* () { yield init(); yield result(handoffTo('codex'), { usage: undefined }); });
    expect((await createClaudeAdapter({ policy, query }).execute(makeInput('claude').input)).usage).toEqual({ kind: 'unavailable' });
  });

  it('forwards cancellation to the SDK abort controller and reports it honestly', async () => {
    const harness = makeInput('claude');
    const { query, calls } = fakeClaude(async function* (options) {
      yield init();
      yield msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } });
      harness.controller.abort();
      if (options.abortController?.signal.aborted) throw new AbortError('aborted');
      yield result(handoffTo('codex'));
    });
    const error = await createClaudeAdapter({ policy, query }).execute(harness.input).catch(e => e);
    expect(error).toBeInstanceOf(ProviderCancelledError);
    expect((error as ProviderCancelledError).confirmed).toBe(true);
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true);
  });

  it('denies out-of-policy tool requests through canUseTool and surfaces the denial', async () => {
    const decisions: unknown[] = [];
    const { query } = fakeClaude(async function* (options) {
      yield init();
      const signal = new AbortController().signal;
      decisions.push(await options.canUseTool!('Bash', { command: 'git push' }, { signal, toolUseID: 'x' } as never));
      decisions.push(await options.canUseTool!('mcp__commonthread__get_task', { id: TASK_ID }, { signal, toolUseID: 'y', mcpServer: { name: 'commonthread', source: 'sdk' } } as never));
      decisions.push(await options.canUseTool!('mcp__commonthread__get_task', { id: TASK_ID }, { signal, toolUseID: 'z', mcpServer: { name: 'commonthread', source: 'project' } } as never));
      yield result(handoffTo('codex'));
    });
    const { input, events } = makeInput('claude');
    await createClaudeAdapter({ policy, query }).execute(input);
    expect(decisions.map(d => (d as { behavior: string }).behavior)).toEqual(['deny', 'allow', 'deny']);
    expect(events.filter(e => e.text.startsWith('Permission denied')).length).toBe(2);
  });
});

type Script = (turnOptions: TurnOptions | undefined) => AsyncGenerator<ThreadEvent>;
function fakeCodex(script: Script, threadId = 'thread-1') {
  const log: { method: 'start' | 'resume'; id?: string; options?: ThreadOptions; turnOptions?: TurnOptions; prompt?: unknown }[] = [];
  const thread = (entry: (typeof log)[number]) => ({
    get id() { return entry.method === 'resume' ? entry.id! : threadId; },
    async runStreamed(prompt: unknown, turnOptions?: TurnOptions) { entry.prompt = prompt; entry.turnOptions = turnOptions; return { events: script(turnOptions) }; },
  });
  const client: CodexClientLike = {
    startThread(options) { const entry = { method: 'start' as const, options }; log.push(entry); return thread(entry); },
    resumeThread(id, options) { const entry = { method: 'resume' as const, id, options }; log.push(entry); return thread(entry); },
  };
  return { client, log };
}
const ev = (value: unknown) => value as ThreadEvent;
const agentMessage = (value: unknown) => ev({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: typeof value === 'string' ? value : JSON.stringify(value) } });
const usage = { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 };

describe('Codex adapter (mocked Codex SDK)', () => {
  it('starts a sandboxed read-only thread and returns actions, thread id and usage', async () => {
    const { client, log } = fakeCodex(async function* () {
      yield ev({ type: 'thread.started', thread_id: 'thread-1' });
      yield ev({ type: 'turn.started' });
      yield ev({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hidden thoughts' } });
      yield ev({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } });
      yield ev({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } });
      yield agentMessage(handoffTo('claude', 'Please revise.'));
      yield ev({ type: 'turn.completed', usage });
    });
    const { input, events } = makeInput('codex');
    const output = await createCodexAdapter({ policy, client }).execute(input);
    expect(output.providerSessionId).toBe('thread-1');
    expect(output.usage).toEqual({ kind: 'reported', inputTokens: 200, outputTokens: 40 });
    expect((output.actions as Action[])[1]).toEqual({ type: 'handoff', recipient: 'claude', taskId: TASK_ID, request: 'Please revise.' });
    expect(log[0]).toMatchObject({ method: 'start', options: { sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false } });
    expect(log[0]!.turnOptions?.signal).toBe(input.signal);
    expect(log[0]!.turnOptions?.outputSchema).toBeDefined();
    expect(events.map(e => e.text)).toEqual(['Running: ls', 'Command completed (exit 0): ls']);
    expect(JSON.stringify(events)).not.toContain('hidden thoughts');
  });

  it('resumes the stored thread and never silently switches threads', async () => {
    const ok = fakeCodex(async function* () { yield ev({ type: 'turn.started' }); yield agentMessage(handoffTo('claude')); yield ev({ type: 'turn.completed', usage }); });
    const output = await createCodexAdapter({ policy, client: ok.client }).execute(makeInput('codex', { providerSessionId: 'thread-9' }).input);
    expect(ok.log[0]).toMatchObject({ method: 'resume', id: 'thread-9' });
    expect(output.providerSessionId).toBe('thread-9');
    const swapped = fakeCodex(async function* () { yield ev({ type: 'thread.started', thread_id: 'other' }); });
    await expect(createCodexAdapter({ policy, client: swapped.client }).execute(makeInput('codex', { providerSessionId: 'thread-9' }).input)).rejects.toBeInstanceOf(SessionResumeError);
    const failed = fakeCodex(async function* () { yield ev({ type: 'turn.failed', error: { message: 'thread not found' } }); });
    await expect(createCodexAdapter({ policy, client: failed.client }).execute(makeInput('codex', { providerSessionId: 'thread-9' }).input)).rejects.toBeInstanceOf(SessionResumeError);
  });

  it('rejects malformed final output, failed turns, and reports missing usage as unavailable', async () => {
    const prose = fakeCodex(async function* () { yield ev({ type: 'turn.started' }); yield agentMessage('Done! I handed it to Claude.'); yield ev({ type: 'turn.completed', usage }); });
    await expect(createCodexAdapter({ policy, client: prose.client }).execute(makeInput('codex').input)).rejects.toBeInstanceOf(ProviderOutputError);
    const failed = fakeCodex(async function* () { yield ev({ type: 'turn.started' }); yield ev({ type: 'turn.failed', error: { message: 'rate limited' } }); });
    await expect(createCodexAdapter({ policy, client: failed.client }).execute(makeInput('codex').input)).rejects.toBeInstanceOf(ProviderExecutionError);
    const noUsage = fakeCodex(async function* () { yield ev({ type: 'turn.started' }); yield agentMessage(handoffTo('claude')); });
    expect((await createCodexAdapter({ policy, client: noUsage.client }).execute(makeInput('codex').input)).usage).toEqual({ kind: 'unavailable' });
  });

  it('reports cancellation without claiming the provider confirmed it stopped', async () => {
    const harness = makeInput('codex');
    const { client } = fakeCodex(async function* (turnOptions) {
      yield ev({ type: 'turn.started' });
      harness.controller.abort();
      if (turnOptions?.signal?.aborted) throw new Error('aborted');
    });
    const error = await createCodexAdapter({ policy, client }).execute(harness.input).catch(e => e);
    expect(error).toBeInstanceOf(ProviderCancelledError);
    expect((error as ProviderCancelledError).confirmed).toBe(false);
  });
});

describe('two-way handoff through both adapters', () => {
  it('extracts Claude → Codex → Claude handoffs with trusted attribution left to the engine', async () => {
    const claude = createClaudeAdapter({ policy, query: fakeClaude(async function* () { yield init(); yield result(handoffTo('codex', 'Review v1')); }).query });
    const codex = createCodexAdapter({ policy, client: fakeCodex(async function* () { yield ev({ type: 'turn.started' }); yield agentMessage(handoffTo('claude', 'Fix finding 1')); yield ev({ type: 'turn.completed', usage }); }).client });
    const first = (await claude.execute(makeInput('claude').input)).actions as Action[];
    const second = (await codex.execute(makeInput('codex').input)).actions as Action[];
    const handoffs = [...first, ...second].filter(action => action.type === 'handoff');
    expect(handoffs.map(action => action.type === 'handoff' && action.recipient)).toEqual(['codex', 'claude']);
    // No action carries an author; the engine derives it from the turn.
    expect(JSON.stringify([...first, ...second])).not.toMatch(/"author"/);
  });
});

describe('live factory gating', () => {
  it('fails closed when live mode is not enabled or the room is a demo room', async () => {
    const disabled = createLiveAdapters({ enabled: false, scratchRoot: tmpdir() });
    await expect(disabled.claude.execute(makeInput('claude').input)).rejects.toBeInstanceOf(LiveDisabledError);
    const enabled = createLiveAdapters({ enabled: true, scratchRoot: tmpdir() });
    await expect(enabled.codex.execute(makeInput('codex', { mode: 'demo' }).input)).rejects.toBeInstanceOf(LiveDisabledError);
    await expect(enabled.codex.execute(makeInput('claude').input)).rejects.toBeInstanceOf(LiveDisabledError);
  });
  it('reads opt-in configuration from env without touching credentials', () => {
    const config = liveConfigFromEnv({ COMMONTHREAD_LIVE: '1', COMMONTHREAD_CLAUDE_MODEL: 'claude-sonnet-5-5', COMMONTHREAD_CLAUDE_MAX_BUDGET_USD: '0.5', ANTHROPIC_API_KEY: 'sk-ant-secret' });
    expect(config).toMatchObject({ enabled: true, claude: { model: 'claude-sonnet-5-5', maxBudgetUsd: 0.5 } });
    expect(JSON.stringify(liveCapabilities(config))).not.toContain('secret');
    expect(liveConfigFromEnv({}).enabled).toBe(false);
  });
});
