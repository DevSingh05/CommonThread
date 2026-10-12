import { spawn } from 'node:child_process';
import { z } from 'zod';

const commandSchema = z.strictObject({
  executable: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
  args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(128),
  cwd: z.string().min(1).max(4096),
  timeoutMs: z.int().min(1).max(120_000).default(10_000),
  maxOutputBytes: z.int().min(1).max(4_194_304).default(262_144),
});
export type Command = z.input<typeof commandSchema>;
export interface CommandResult {
  command: { executable: string; args: string[] }; cwd: string; startedAt: string; completedAt: string;
  status: 'exited' | 'spawn_error' | 'cancelled' | 'timed_out' | 'output_limit';
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
}

/** Internal primitive. Only trusted host code may choose executables/arguments. No shell. */
export async function executeBounded(input: Command, signal?: AbortSignal): Promise<CommandResult> {
  const command = commandSchema.parse(input);
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  // Do not let inherited Git overrides redirect operations outside the selected repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', LC_ALL: 'C' });
  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let status: CommandResult['status'] = 'exited';
    let bytes = 0;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const stop = (reason: CommandResult['status']) => {
      if (status !== 'exited') return;
      status = reason; child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timed_out'), command.timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = command.maxOutputBytes - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > command.maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', () => { status = 'spawn_error'; });
    // Ownership must remain held until close, even if a descendant retains the pipes.
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ command: { executable: command.executable, args: [...command.args] }, cwd: command.cwd,
        startedAt, completedAt: new Date().toISOString(), status, exitCode, signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export async function git(cwd: string, args: string[], signal?: AbortSignal, allowFailure = false): Promise<string> {
  const result = await executeBounded({ executable: 'git', cwd,
    args: ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    maxOutputBytes: 4_194_304 }, signal);
  if (result.status !== 'exited' || (!allowFailure && result.exitCode !== 0)) throw new Error('Repository Git inspection failed or exceeded its limits.');
  return result.exitCode === 0 ? result.stdout : '';
}
