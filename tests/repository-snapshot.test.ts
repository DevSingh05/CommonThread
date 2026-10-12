import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeRepository, captureStableSnapshot, changesBetween, validateRelativePath } from '../src/repository/snapshot.js';
import { executeBounded } from '../src/repository/process.js';

const dirs: string[] = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'commonthread-repository-')); dirs.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  writeFileSync(join(root, 'code.txt'), 'original\n');
  execFileSync('git', ['add', 'code.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Repository Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('repository capture boundaries', () => {
  it('captures clean, dirty, staged, untracked and deleted state without changing it', async () => {
    const root = repository(); const identity = await canonicalizeRepository(root);
    const clean = await captureStableSnapshot(identity);
    expect(clean.status).toBe('');
    writeFileSync(join(root, 'code.txt'), 'staged\n');
    execFileSync('git', ['add', 'code.txt'], { cwd: root });
    writeFileSync(join(root, 'code.txt'), 'human dirty\n');
    writeFileSync(join(root, 'human.txt'), 'untracked human\n');
    const before = await captureStableSnapshot(identity);
    expect(before.files.find(file => file.path === 'code.txt')?.contentBase64).toBe(Buffer.from('human dirty\n').toString('base64'));
    writeFileSync(join(root, 'code.txt'), 'human dirty\nturn addition\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const after = await captureStableSnapshot(identity);
    const changes = changesBetween(before, after);
    expect(changes.map(change => [change.path, change.preExisting, change.kind])).toEqual([['code.txt', true, 'modified'], ['new.txt', false, 'added']]);
    expect(changes[0]?.before?.hash).toBe(before.files.find(file => file.path === 'code.txt')?.hash);
    expect(readFileSync(join(root, 'human.txt'), 'utf8')).toBe('untracked human\n');
    expect(after.index).toBe(before.index);
    rmSync(join(root, 'code.txt'));
    expect(changesBetween(after, await captureStableSnapshot(identity))[0]?.kind).toBe('deleted');
  });
  it('resolves subdirectories, symlink aliases and linked Git worktrees', async () => {
    const root = repository(); mkdirSync(join(root, 'nested'));
    const aliasParent = mkdtempSync(join(tmpdir(), 'commonthread-alias-')); dirs.push(aliasParent);
    const alias = join(aliasParent, 'alias'); symlinkSync(root, alias, 'junction');
    const identity = await canonicalizeRepository(root);
    expect(await canonicalizeRepository(alias)).toEqual(identity);
    expect(await canonicalizeRepository(join(root, 'nested'))).toEqual(identity);
    const linked = join(aliasParent, 'linked');
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'linked', linked], { cwd: root });
    const worktree = await canonicalizeRepository(linked);
    expect(worktree.root).not.toBe(identity.root);
    expect(worktree.gitDir).not.toBe(identity.gitDir);
    expect(worktree.commonDir).toBe(identity.commonDir);
    expect((await captureStableSnapshot(worktree)).files).toHaveLength(1);
  });
  it('rejects traversal, alternate streams, metadata and symlink escapes', async () => {
    for (const path of ['../outside', '/absolute', 'C:/file', 'a\\b', 'a/../../b', '.git/config', 'a/.GIT/config', 'x:stream', './a', 'a//b']) {
      expect(() => validateRelativePath(path)).toThrow();
    }
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), 'commonthread-outside-')); dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, join(root, 'escape'), 'junction');
    await expect(captureStableSnapshot(await canonicalizeRepository(root))).rejects.toThrow(/Symlinks|regular/);
  });
  it('fails closed at file, total-byte and file-count limits', async () => {
    const root = repository(); const identity = await canonicalizeRepository(root);
    await expect(captureStableSnapshot(identity, undefined, { maxFileBytes: 2 })).rejects.toThrow(/limit/);
    writeFileSync(join(root, 'extra.txt'), 'content');
    await expect(captureStableSnapshot(identity, undefined, { maxTotalBytes: 10 })).rejects.toThrow(/limit/);
    await expect(captureStableSnapshot(identity, undefined, { maxFiles: 1 })).rejects.toThrow(/limit/);
  });
  it('supports unborn repositories and aborts before inspecting files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'commonthread-unborn-')); dirs.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    const identity = await canonicalizeRepository(root);
    expect((await captureStableSnapshot(identity)).head).toBe('');
    await expect(captureStableSnapshot(identity, AbortSignal.abort())).rejects.toThrow();
  });
});

describe('bounded command primitive', () => {
  it('records literal arguments and caps combined process output', async () => {
    const result = await executeBounded({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000))'], cwd: tmpdir(), maxOutputBytes: 32 });
    expect(result.status).toBe('output_limit'); expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(32);
    const literal = '$(unsafe); & literal';
    const echo = await executeBounded({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', literal], cwd: tmpdir() });
    expect(echo.stdout).toBe(literal); expect(echo.exitCode).toBe(0);
  });
  it('records nonzero exits, spawn failures, timeouts and cancellation', async () => {
    const command = { executable: process.execPath, args: ['-e', 'process.exit(7)'], cwd: tmpdir() };
    expect((await executeBounded(command)).exitCode).toBe(7);
    expect((await executeBounded({ ...command, executable: join(tmpdir(), 'missing-commonthread-executable') })).status).toBe('spawn_error');
    const waiting = { ...command, args: ['-e', 'setInterval(() => {}, 1000)'] };
    expect((await executeBounded({ ...waiting, timeoutMs: 30 })).status).toBe('timed_out');
    const controller = new AbortController(); const pending = executeBounded(waiting, controller.signal); controller.abort();
    expect((await pending).status).toBe('cancelled');
  });
});
