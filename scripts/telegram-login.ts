/**
 * First-run Telegram authentication, on its own.
 *
 * Telegram sends a login code that only exists at the moment it is asked for,
 * so this has to be run by a human at a terminal. Once the session string is
 * saved, the bridge starts unattended forever after.
 *
 * Deliberately independent of the rest of the config: authenticating should
 * not require Instagram credentials or a reachable PUBLIC_BASE_URL.
 *
 *   pnpm run login
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TelegramStoryReader } from '../src/telegram/reader.js';
import { DEFAULT_ALLOWED_SCOPES } from '../src/telegram/scope.js';
import { createLogger } from '../src/utils/logger.js';
import { isInteractive } from '../src/utils/prompt.js';

const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER ?? '';
const sessionFile = process.env.TELEGRAM_SESSION_FILE ?? './data/telegram-session.txt';

if (!apiId || !apiHash || !phoneNumber) {
  console.error(
    'Missing credentials. TELEGRAM_API_ID, TELEGRAM_API_HASH and ' +
      'TELEGRAM_PHONE_NUMBER must all be set in .env'
  );
  process.exit(1);
}

if (!isInteractive()) {
  console.error(
    'This needs a real terminal: Telegram will ask for a login code that has ' +
      'to be typed in. Run it directly from your shell, not through a pipe.'
  );
  process.exit(1);
}

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

console.log(`\nAuthenticating ${phoneNumber} — Telegram will send a code to your other devices.\n`);

const reader = new TelegramStoryReader(
  {
    apiId,
    apiHash,
    phoneNumber,
    sessionString: process.env.TELEGRAM_SESSION_STRING ?? '',
    tempDir: process.env.TEMP_DIR ?? './data/temp',
    // This script only authenticates; it never reads a story.
    allowedScopes: DEFAULT_ALLOWED_SCOPES,
  },
  logger
);

try {
  const sessionString = await reader.connect();

  const path = resolve(process.cwd(), sessionFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sessionString, { mode: 0o600 });

  console.log(`\n✅ Session saved to ${path} (mode 0600)`);
  console.log('   Copy it into TELEGRAM_SESSION_STRING in .env, then delete the file.');
  console.log('   It grants full access to this Telegram account — never commit or paste it.\n');
} catch (error) {
  console.error('\n❌ Authentication failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await reader.disconnect().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
