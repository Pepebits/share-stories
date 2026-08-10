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

export interface TelegramConfig {
  botToken: string;
  businessConnectionId: string;
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  sessionString: string;
  monitoredPeers: string[];
}

export interface InstagramConfig {
  username: string;
  password: string;
  sessionPath: string;
  monitoredUsers: string[];
  graphAppId: string;
  graphAppSecret: string;
  graphAccountId: string;
  graphAccessToken: string;
}

export interface AppConfig {
  telegram: TelegramConfig;
  instagram: InstagramConfig;
  pollIntervalSeconds: number;
  databasePath: string;
  tempDir: string;
  logLevel: string;
  projectRoot: string;
}

export function loadConfig(): AppConfig {
  const monitoredPeersRaw = optionalEnv('TELEGRAM_MONITORED_PEERS');
  const monitoredUsersRaw = optionalEnv('INSTAGRAM_MONITORED_USERS');

  return {
    projectRoot,
    telegram: {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      businessConnectionId: optionalEnv('TELEGRAM_BUSINESS_CONNECTION_ID'),
      apiId: parseIntEnv('TELEGRAM_API_ID', 0),
      apiHash: optionalEnv('TELEGRAM_API_HASH'),
      phoneNumber: optionalEnv('TELEGRAM_PHONE_NUMBER'),
      sessionString: optionalEnv('TELEGRAM_SESSION_STRING'),
      monitoredPeers: monitoredPeersRaw
        ? monitoredPeersRaw.split(',').map((p) => p.trim()).filter(Boolean)
        : [],
    },
    instagram: {
      username: requireEnv('INSTAGRAM_USERNAME'),
      password: requireEnv('INSTAGRAM_PASSWORD'),
      sessionPath: optionalEnv('INSTAGRAM_SESSION_PATH', './data/instagram_session.json'),
      monitoredUsers: monitoredUsersRaw
        ? monitoredUsersRaw.split(',').map((u) => u.trim()).filter(Boolean)
        : [],
      graphAppId: optionalEnv('INSTAGRAM_GRAPH_APP_ID'),
      graphAppSecret: optionalEnv('INSTAGRAM_GRAPH_APP_SECRET'),
      graphAccountId: optionalEnv('INSTAGRAM_GRAPH_ACCOUNT_ID'),
      graphAccessToken: optionalEnv('INSTAGRAM_GRAPH_ACCESS_TOKEN'),
    },
    pollIntervalSeconds: parseIntEnv('POLL_INTERVAL_SECONDS', 120),
    databasePath: optionalEnv('DATABASE_PATH', './data/state.db'),
    tempDir: optionalEnv('TEMP_DIR', './data/temp'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}
