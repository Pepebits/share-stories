import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
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
// truncated session on disk — GramJS would treat that as a corrupt session
// rather than a missing one.
export function writeSession(path: string, session: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, session, { mode: 0o600 });
  renameSync(tmpPath, path);
}
