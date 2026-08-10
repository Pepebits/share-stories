import { IgApiClient } from 'instagram-private-api';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

export async function createInstagramClient(
  username: string,
  password: string,
  sessionPath: string,
  logger: Logger
): Promise<IgApiClient> {
  const ig = new IgApiClient();

  // Ensure session directory exists
  const sessionDir = dirname(sessionPath);
  if (!existsSync(sessionDir)) {
    await mkdir(sessionDir, { recursive: true });
  }

  ig.state.generateDevice(username);

  // Try to restore session
  let sessionRestored = false;
  if (existsSync(sessionPath)) {
    try {
      const sessionData = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(sessionData);
      await ig.state.deserialize(session);
      sessionRestored = true;
      logger.info('Instagram session restored from file');
    } catch (err) {
      logger.warn('Failed to restore Instagram session, will re-login', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!sessionRestored) {
    await withRetry(
      async () => {
        await ig.account.login(username, password);
      },
      {
        maxRetries: 3,
        baseDelayMs: 5000,
        maxDelayMs: 30000,
        logger,
        operation: 'instagram-login',
      }
    );

    // Save session
    const serialized = await ig.state.serialize();
    await writeFile(sessionPath, JSON.stringify(serialized), 'utf-8');
    logger.info('Instagram session saved');
  }

  // Simulate pre-login flow to reduce suspicion
  try {
    await ig.simulate.preLoginFlow();
  } catch {
    logger.debug('preLoginFlow skipped (may already be logged in)');
  }

  logger.info('Instagram client ready', { username });
  return ig;
}

export function isIgClientConnected(ig: IgApiClient): boolean {
  try {
    // Instagram session is considered valid if we have a userId stored
    const state = ig.state as any;
    return !!(state.cookieUserId || state.userId || state.authorization);
  } catch {
    return true;
  }
}
