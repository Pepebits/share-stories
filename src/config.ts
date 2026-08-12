import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Check your .env file.`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string = ''): string {
  return process.env[key] ?? fallback;
}

function parseIntEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function parseListEnv(key: string): string[] {
  const raw = optionalEnv(key);
  return raw
    ? raw.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  sessionString: string;
  monitoredPeers: string[];
}

export interface InstagramConfig {
  accountId: string;
  accessToken: string;
}

export interface MediaServerSettings {
  port: number;
  host: string;
  publicBaseUrl: string;
  ttlSeconds: number;
}

export interface AppConfig {
  telegram: TelegramConfig;
  instagram: InstagramConfig;
  mediaServer: MediaServerSettings;
  pollIntervalSeconds: number;
  databasePath: string;
  tempDir: string;
  sessionFilePath: string;
  logLevel: string;
  projectRoot: string;
}

/**
 * Meta fetches story media from PUBLIC_BASE_URL over the open internet. A
 * loopback or private address means every publish will fail with an opaque
 * container ERROR, so fail loudly here instead.
 */
function validatePublicBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: ${raw}`);
  }

  const unreachable = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i;
  if (unreachable.test(url.hostname) || unreachable.test(url.host)) {
    throw new Error(
      `PUBLIC_BASE_URL points at ${url.hostname}, which Instagram cannot reach. ` +
        'It must be a public address or hostname, typically a reverse proxy in front of this process.'
    );
  }

  return url.origin;
}

export function loadConfig(): AppConfig {
  const publicBaseUrl = validatePublicBaseUrl(requireEnv('PUBLIC_BASE_URL'));

  return {
    projectRoot,
    telegram: {
      apiId: parseIntEnv('TELEGRAM_API_ID', 0),
      apiHash: requireEnv('TELEGRAM_API_HASH'),
      phoneNumber: requireEnv('TELEGRAM_PHONE_NUMBER'),
      sessionString: optionalEnv('TELEGRAM_SESSION_STRING'),
      monitoredPeers: parseListEnv('TELEGRAM_MONITORED_PEERS'),
    },
    instagram: {
      accountId: requireEnv('INSTAGRAM_ACCOUNT_ID'),
      accessToken: requireEnv('INSTAGRAM_ACCESS_TOKEN'),
    },
    mediaServer: {
      port: parseIntEnv('MEDIA_SERVER_PORT', 8080),
      // Loopback by default: expose it through a TLS-terminating proxy.
      host: optionalEnv('MEDIA_SERVER_HOST', '127.0.0.1'),
      publicBaseUrl,
      ttlSeconds: parseIntEnv('MEDIA_URL_TTL_SECONDS', 600),
    },
    pollIntervalSeconds: parseIntEnv('POLL_INTERVAL_SECONDS', 120),
    databasePath: optionalEnv('DATABASE_PATH', './data/state.db'),
    tempDir: optionalEnv('TEMP_DIR', './data/temp'),
    sessionFilePath: optionalEnv('TELEGRAM_SESSION_FILE', './data/telegram-session.txt'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}
