import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeBounded } from '../src/repository/process.js';

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
