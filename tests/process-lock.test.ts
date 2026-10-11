import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { acquireProcessLock } from '../src/server/process-lock.js';

describe('local process ownership', () => {
  it('rejects another owner and allows startup after release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonthread-process-')); const path = join(dir, 'server.lock');
    try {
      const unlock = acquireProcessLock(path);
      expect(() => acquireProcessLock(path)).toThrow(/already owns/);
      unlock(); const unlockAgain = acquireProcessLock(path); unlockAgain();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not silently delete a malformed lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonthread-process-')); const path = join(dir, 'server.lock');
    try { writeFileSync(path, 'not-a-pid'); expect(() => acquireProcessLock(path)).toThrow(/Invalid lock/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
