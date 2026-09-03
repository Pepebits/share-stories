/**
 * First-run Telegram authentication: Telegram sends a login code that has to be typed
 * in, so this runs at a terminal once and the bridge starts unattended after that.
 * Independent of the rest of the config, so authenticating needs no Instagram credentials.
 *
 *   pnpm run login
 */
import { resolve } from 'node:path';
import { TelegramStoryReader } from '../src/telegram/reader.js';
import { writeSession } from '../src/telegram/session.js';
import { DEFAULT_ALLOWED_SCOPES } from '../src/telegram/scope.js';
import { createLogger } from '../src/utils/logger.js';
import { isInteractive } from '../src/utils/prompt.js';
import { loadDotEnv } from '../src/utils/env.js';

loadDotEnv();

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
    // This script only authenticates; it never reads a story.
    allowedScopes: DEFAULT_ALLOWED_SCOPES,
  },
  logger
);

try {
  const sessionString = await reader.login();

  const path = resolve(process.cwd(), sessionFile);
  writeSession(path, sessionString);

  console.log(`\n✅ Session saved to ${path} (mode 0600)`);
  console.log('   The bridge reads it from there — nothing else to copy. In Docker, mounting');
  console.log('   ./data is enough.');
  console.log('   It grants full access to this Telegram account — never commit or share it.\n');
} catch (error) {
  console.error('\n❌ Authentication failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await reader.disconnect().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
