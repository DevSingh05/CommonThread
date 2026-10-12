import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AppError, invariant } from '../core/errors.js';
import { git } from './process.js';

export interface RepositoryIdentity { root: string; gitDir: string; commonDir: string }
export interface FileState { path: string; hash: string; bytes: number; mode: number; contentBase64: string }
export interface RepositorySnapshot {
  identity: RepositoryIdentity; capturedAt: string; head: string; index: string; status: string;
  files: FileState[]; digest: string;
}
const limitsSchema = z.strictObject({
  maxFiles: z.int().min(1).max(10_000).default(1000),
  maxFileBytes: z.int().min(1).max(1_048_576).default(262_144),
  maxTotalBytes: z.int().min(1).max(8_388_608).default(2_097_152),
});
export type CaptureLimits = z.input<typeof limitsSchema>;
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export async function canonicalizeRepository(path: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
  z.string().min(1).max(4096).refine(value => !value.includes('\0')).parse(path);
  signal?.throwIfAborted();
  const requested = await realpath(resolve(path));
  invariant((await stat(requested)).isDirectory(), 'INVALID_REPOSITORY', 'Repository must be a directory.');
  const root = await realpath((await git(requested, ['rev-parse', '--show-toplevel'], signal)).trimEnd());
  const gitDir = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'], signal)).trimEnd());
  const commonDir = await realpath(resolve(root, (await git(root, ['rev-parse', '--git-common-dir'], signal)).trimEnd()));
  return { root, gitDir, commonDir };
}

export function validateRelativePath(path: string): string {
  invariant(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !isAbsolute(path)
    && !/[\\:\0\uFFFD]/u.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'
      || part.toLowerCase() === '.git' || (process.platform === 'win32' && /[. ]$/u.test(part))),
  'UNSAFE_PATH', 'Repository file path must be relative, without traversal or Git metadata.');
  return path;
}

async function readFileState(root: string, path: string, maxBytes: number): Promise<FileState | undefined> {
  validateRelativePath(path);
  const full = join(root, ...path.split('/'));
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    invariant(!entry.isSymbolicLink(), 'UNSAFE_PATH', 'Symlinks inside repository captures are unsupported.');
  }
  const resolved = await realpath(full);
  const rel = relative(root, resolved);
  invariant(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'UNSAFE_PATH', 'Repository path escaped its root.');
  const info = await lstat(full);
  invariant(info.isFile() && info.nlink === 1, 'UNSUPPORTED_FILE', 'Only regular, non-hardlinked repository files are supported.');
  invariant(info.size <= maxBytes, 'CAPTURE_LIMIT', 'Repository file exceeds capture byte limit.');
  const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    invariant(before.isFile() && before.ino === info.ino && before.dev === info.dev && before.size <= maxBytes,
      'EXTERNAL_CHANGE', 'Repository file changed while opening a capture.');
    // Read at most the configured bound plus one byte, even if a concurrent writer grows the file.
    const buffer = Buffer.alloc(Math.min(maxBytes, before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    invariant(offset === before.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size,
      'EXTERNAL_CHANGE', 'Repository file changed during capture.');
    const content = buffer.subarray(0, offset);
    return { path, hash: hash(content), bytes: content.length, mode: before.mode & 0o777, contentBase64: content.toString('base64') };
  } finally { await file.close(); }
}

export async function captureSnapshot(identity: RepositoryIdentity, signal?: AbortSignal, input: CaptureLimits = {}): Promise<RepositorySnapshot> {
  const limits = limitsSchema.parse(input);
  signal?.throwIfAborted();
  const actual = await canonicalizeRepository(identity.root, signal);
  invariant(JSON.stringify(actual) === JSON.stringify(identity), 'EXTERNAL_CHANGE', 'Repository identity changed.');
  const index = await git(identity.root, ['ls-files', '--stage', '-z'], signal);
  invariant(!index.split('\0').some(entry => entry.startsWith('160000 ')), 'UNSUPPORTED_SUBMODULE', 'Submodules require a separate repository room.');
  const paths = [...new Set((await git(identity.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean))].sort();
  invariant(paths.length <= limits.maxFiles, 'CAPTURE_LIMIT', 'Repository exceeds capture file limit.');
  const files: FileState[] = [];
  let total = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const file = await readFileState(identity.root, path, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total));
    if (file) { total += file.bytes; files.push(file); }
  }
  const head = await git(identity.root, ['rev-parse', '--verify', 'HEAD'], signal, true);
  const status = await git(identity.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
  const content = { identity, head, index, status, files };
  return { ...content, capturedAt: new Date().toISOString(), digest: hash(JSON.stringify(content)) };
}

export async function captureStableSnapshot(identity: RepositoryIdentity, signal?: AbortSignal, limits: CaptureLimits = {}): Promise<RepositorySnapshot> {
  const before = await captureSnapshot(identity, signal, limits);
  const after = await captureSnapshot(identity, signal, limits);
  if (before.digest !== after.digest) throw new AppError('EXTERNAL_CHANGE', 'Repository changed during capture; no reconciliation was attempted.');
  return after;
}

export interface FileChange {
  path: string; kind: 'added' | 'modified' | 'deleted'; preExisting: boolean;
  attribution: 'observed_during_turn_uncertain'; before?: FileState; after?: FileState;
}
export function changesBetween(before: RepositorySnapshot, after: RepositorySnapshot): FileChange[] {
  const left = new Map(before.files.map(file => [file.path, file]));
  const right = new Map(after.files.map(file => [file.path, file]));
  const dirty = new Set<string>();
  const entries = before.status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    dirty.add(entry.slice(3));
    if (/^[RC]|^.[RC]/u.test(entry)) { const old = entries[++i]; if (old) dirty.add(old); }
  }
  return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(path => {
    const a = left.get(path); const b = right.get(path);
    if (a?.hash === b?.hash && a?.mode === b?.mode) return [];
    return [{ path, kind: !a ? 'added' : !b ? 'deleted' : 'modified', preExisting: dirty.has(path),
      attribution: 'observed_during_turn_uncertain', before: a, after: b } satisfies FileChange];
  });
}
