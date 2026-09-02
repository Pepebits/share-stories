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

// Written via a temp file + rename so a crash mid-write can never leave a
// truncated session on disk — GramJS would treat that as a corrupt session
// rather than a missing one.
export function writeSession(path: string, session: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, session, { mode: 0o600 });
  renameSync(tmpPath, path);
}
