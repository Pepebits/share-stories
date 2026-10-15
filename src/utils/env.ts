import { statSync } from 'node:fs';

/**
 * Warns when the .env file holding the tokens can be read by other local users. Warn, never
 * refuse: a refusal would break existing deployments that were set up with `cp` and a 022
 * umask. Printed to stderr because this runs before the logger (it needs the config this loads).
 */
function warnIfReadableByOthers(path: string): void {
  // Windows has no group/other permission bits to read.
  if (process.platform === 'win32') return;

  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      console.error(
        `Warning: ${path} is readable by other users on this machine and holds secrets. ` +
          `Run: chmod 600 ${path}`
      );
    }
  } catch {
    // The load above succeeded, so a failed stat is not worth failing startup over.
  }
}

/**
 * No-op in Docker: .env does not exist inside the container, which gets its vars from env_file.
 * The path defaults to ./.env, as process.loadEnvFile does.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  warnIfReadableByOthers(path);
}
