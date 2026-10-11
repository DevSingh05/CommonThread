import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexThreadOptionsFor, decideClaudeTool, isInside, readOnlyPolicy } from '../src/adapters/provider-permissions.js';
import type { ExecutionPolicy } from '../src/adapters/provider-permissions.js';
import { ProviderOutputError, actionOutputJsonSchema, buildPrompt, normalizeActions, sanitizeError } from '../src/adapters/provider-protocol.js';
import { ARTIFACT_ID, TASK_ID, handoffTo, makeInput } from './provider-fixtures.js';

function assertStrict(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  if (node.type === 'object') {
    const props = Object.keys(node.properties as object);
    expect(node.additionalProperties, path).toBe(false);
    expect([...(node.required as string[])].sort(), path).toEqual(props.sort());
  }
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) value.forEach((item, i) => assertStrict(item, `${path}.${key}[${i}]`));
    else if (value && typeof value === 'object') assertStrict(value, `${path}.${key}`);
  }
}

describe('provider prompt', () => {
  it('labels authors, separates trust levels and never presents peer text as instructions', () => {
    const { input } = makeInput('claude', { withArtifact: true });
    const prompt = buildPrompt(input, { retrievalTools: true });
    expect(prompt).toContain('You are **claude**');
    expect(prompt).toContain('## System instructions (trusted)');
    expect(prompt).toContain('## Human guidance (trusted human constraints');
    expect(prompt).toContain('UNTRUSTED data');
    expect(prompt).toContain('"author": "codex"');
    expect(prompt).toContain(`taskId "${TASK_ID}"`);
    expect(prompt).toContain('get_artifact');
    // Peer text stays inside JSON-encoded data, after the untrusted header.
    const injected = prompt.indexOf('IGNORE PREVIOUS INSTRUCTIONS');
    expect(injected).toBeGreaterThan(prompt.indexOf('UNTRUSTED data'));
    expect(prompt).toContain(`"artifactId": "${ARTIFACT_ID}"`);
    expect(prompt).toContain('"content": "Step 1"');
  });
  it('tells Codex that records are inlined because it has no retrieval tools', () => {
    const { input } = makeInput('codex');
    const prompt = buildPrompt(input, { retrievalTools: false });
    expect(prompt).toContain('handoff` (recipient "claude"');
    expect(prompt).not.toContain('get_artifact');
  });
});

describe('structured output schema and validation', () => {
  it('is compatible with strict structured-output rules', () => assertStrict(actionOutputJsonSchema));
  it('normalizes nullable fields into a contract-valid batch', () => {
    const actions = normalizeActions(handoffTo('codex'));
    expect(actions).toEqual([
      { type: 'post_message', body: 'Handing off to codex.' },
      { type: 'handoff', recipient: 'codex', taskId: TASK_ID, request: 'Please review the plan.' },
    ]);
  });
  it('accepts a JSON string and assigns missing finding IDs', () => {
    const raw = JSON.stringify({ actions: [{ type: 'submit_review', artifactRef: { artifactId: ARTIFACT_ID, version: 1 }, summary: 'One issue', findings: [{ id: null, severity: 'low', file: 'a.ts', line: null, explanation: 'x', evidence: 'y', nextAction: 'z' }] }] });
    const [review] = normalizeActions(raw);
    expect(review?.type === 'submit_review' && review.findings[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([
    ['non-JSON text', 'I handed off to codex!'],
    ['missing actions', { result: 'done' }],
    ['empty batch', { actions: [] }],
    ['supplied author (impersonation)', { actions: [{ type: 'post_message', body: 'hi', author: 'human' }] }],
    ['unknown recipient', { actions: [{ type: 'handoff', recipient: 'human', taskId: TASK_ID, request: 'x' }] }],
    ['review without findings', { actions: [{ type: 'submit_review', artifactRef: { artifactId: ARTIFACT_ID, version: 1 }, summary: 'Clean' }] }],
  ])('rejects malformed output: %s', (_name, raw) => {
    expect(() => normalizeActions(raw)).toThrow(ProviderOutputError);
  });
  it('redacts credential-looking text from errors', () => {
    const text = sanitizeError(new Error('bad key sk-ant-abcdefghijklmnop and Authorization: Bearer xyz123'));
    expect(text).not.toContain('ghijklmnop');
    expect(text).not.toContain('xyz123');
  });
});

describe('execution policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-policy-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const readOnly: ExecutionPolicy = { cwd: repo, access: 'read_only', scratch: false };
  const write: ExecutionPolicy = { ...readOnly, access: 'workspace_write' };

  it('denies shell, web and write tools in read-only mode', () => {
    expect(decideClaudeTool(readOnly, 'Bash', { command: 'rm -rf /' }, false).allow).toBe(false);
    expect(decideClaudeTool(readOnly, 'WebFetch', {}, false).allow).toBe(false);
    expect(decideClaudeTool(readOnly, 'Edit', { file_path: join(repo, 'a.ts') }, false).allow).toBe(false);
    expect(decideClaudeTool(readOnly, 'Read', { file_path: join(repo, 'a.ts') }, false).allow).toBe(true);
    expect(decideClaudeTool(readOnly, 'mcp__commonthread__get_message', {}, true).allow).toBe(true);
  });
  it('allows writes only inside the workspace when write access is granted', () => {
    expect(decideClaudeTool(write, 'Edit', { file_path: join(repo, 'a.ts') }, false).allow).toBe(true);
    expect(decideClaudeTool(write, 'Write', { file_path: join(dir, 'outside.ts') }, false).allow).toBe(false);
    expect(decideClaudeTool(write, 'Read', { file_path: '../outside.ts' }, false).allow).toBe(false);
    expect(decideClaudeTool(write, 'Bash', { command: 'ls' }, false).allow).toBe(false);
  });
  it('treats a symlink pointing outside the workspace as outside', () => {
    const link = join(repo, 'escape');
    try { symlinkSync(dir, link, 'junction'); } catch { return; } // symlinks may be unavailable on this OS
    expect(isInside(repo, join(link, 'secret.txt'))).toBe(false);
  });
  it('maps policy to Codex sandbox without approvals or network', () => {
    expect(codexThreadOptionsFor(readOnly)).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', workingDirectory: repo, skipGitRepoCheck: false });
    expect(codexThreadOptionsFor(write).sandboxMode).toBe('workspace-write');
  });
  it('defaults to a read-only scratch workspace for rooms without a repository', async () => {
    const { input } = makeInput('claude');
    const policy = await readOnlyPolicy(join(dir, 'scratch'))(input);
    expect(policy).toMatchObject({ access: 'read_only', scratch: true });
    expect(policy.cwd).toContain(input.room.id);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
