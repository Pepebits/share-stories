import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function readSession(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export type SessionSource = 'file' | 'env' | 'none';

/**
 * The file wins whenever it exists: the bridge rewrites it when Telegram rotates the session,
 * while an environment variable stays frozen at whatever it was when the process was launched.
 * The variable is only a seed for a first start without the file.
 */
export function resolveSession(
  path: string,
  fromEnv: string | undefined
): { session: string; source: SessionSource } {
  const fromFile = readSession(path);
  if (fromFile) return { session: fromFile, source: 'file' };
  const seed = fromEnv?.trim() ?? '';
  return seed ? { session: seed, source: 'env' } : { session: '', source: 'none' };
}

// Written via a temp file + rename so a crash mid-write can never leave a
// truncated session on disk — teleproto would treat that as a corrupt session
// rather than a missing one. The mode only applies when a file is created, so a stale or
// planted `.tmp` (a looser mode, or a symlink) is removed first and the new one opened with
// 'wx' (O_EXCL), which refuses to follow or reuse anything that appears in between.
export function writeSession(path: string, session: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp`;
  rmSync(tmpPath, { force: true });
  writeFileSync(tmpPath, session, { mode: 0o600, flag: 'wx' });
  renameSync(tmpPath, path);
}
