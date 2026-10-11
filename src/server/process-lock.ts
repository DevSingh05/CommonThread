import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { AppError } from '../core/errors.js';

/** One service owner per database directory. App locks cannot control unrelated external editors. */
export function acquireProcessLock(path: string): () => void {
  if (existsSync(path)) {
    const initial = lstatSync(path);
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new AppError('INVALID_PROCESS_LOCK', 'Invalid lock file. Verify no server uses this data directory before removing its server.lock.');
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new AppError('ALREADY_RUNNING', 'A CommonThread server already owns this data directory. Use that server or a different data directory.');
    if (lstatSync(path).ino === initial.ino) unlinkSync(path);
  }
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new AppError('ALREADY_RUNNING', 'Could not acquire exclusive data-directory ownership.'); }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  const identity = lstatSync(path);
  return () => { if (existsSync(path) && lstatSync(path).ino === identity.ino) unlinkSync(path); };
}
