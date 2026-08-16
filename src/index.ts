import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { StateStore } from './db/state.js';
import { TelegramStoryReader } from './telegram/reader.js';
import { getAccountInfo } from './instagram/graph-api.js';
import { TokenManager, DEFAULT_TOKEN_OPTIONS } from './instagram/token-manager.js';
import { QuotaGuard } from './instagram/quota.js';
import { MediaServer } from './http/media-server.js';
import { createTgToIgBridge } from './bridge/tg-to-ig.js';
import { cleanupTempDir, ensureTempDir } from './bridge/media.js';

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Share Historys — Story Bridge        ║');
  console.log('║  Telegram → Instagram (official API)     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const store = new StateStore(config.databasePath);
  logger.info('State store initialized', { dbPath: config.databasePath });

  await ensureTempDir(config.tempDir);
  const cleanupInterval = setInterval(
    () => void cleanupTempDir(config.tempDir, 3_600_000, logger),
    1_800_000
  );

  // Long-lived tokens expire after 60 days, so the running token is whatever
  // the last refresh produced — not necessarily what is sitting in .env.
  const tokens = new TokenManager(
    {
      filePath: resolve(config.projectRoot, config.instagramTokenFile),
      envToken: config.instagram.accessToken,
      accountId: config.instagram.accountId,
      ...DEFAULT_TOKEN_OPTIONS,
    },
    logger
  );
  await tokens.load();
  await tokens.refreshIfNeeded();
  tokens.start();

  // Verify the token before a story ever arrives, so a bad one surfaces at
  // boot rather than at 3am when something is worth reposting.
  const account = await getAccountInfo(tokens.config(), logger);
  if (!account) {
    throw new Error(
      'Instagram credentials rejected. Check INSTAGRAM_ACCOUNT_ID and INSTAGRAM_ACCESS_TOKEN ' +
        '(long-lived tokens expire after 60 days).'
    );
  }
  logger.info(`Instagram account ready: @${account.username}`);

  const quota = new QuotaGuard(
    () => tokens.config(),
    {
      reserve: config.instagram.quotaReserve,
      refreshIntervalMs: config.instagram.quotaRefreshSeconds * 1000,
    },
    logger
  );

  // Read it once at boot so the first story does not discover the quota is
  // already spent after building a container for nothing.
  await quota.ensureCapacity().catch(() => {});
  if (quota.snapshot) {
    logger.info(
      `Publish quota: ${quota.snapshot.used}/${quota.snapshot.total} used ` +
        `in the last ${Math.round(quota.snapshot.durationSeconds / 3600)}h`
    );
  }

  const mediaServer = new MediaServer(
    {
      port: config.mediaServer.port,
      host: config.mediaServer.host,
      publicBaseUrl: config.mediaServer.publicBaseUrl,
      ttlMs: config.mediaServer.ttlSeconds * 1000,
    },
    logger
  );
  await mediaServer.start();

  const reader = new TelegramStoryReader(
    {
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      phoneNumber: config.telegram.phoneNumber,
      sessionString: config.telegram.sessionString,
      tempDir: config.tempDir,
    },
    logger
  );

  const sessionString = await reader.connect();

  // The session string is a bearer credential for the Telegram account. It
  // must never reach the logs, which on a VPS means journald and any shipper.
  if (sessionString && sessionString !== config.telegram.sessionString) {
    const sessionPath = resolve(config.projectRoot, config.sessionFilePath);
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, sessionString, { mode: 0o600 });
    logger.warn(
      `New Telegram session written to ${sessionPath} (mode 0600). ` +
        'Copy it into TELEGRAM_SESSION_STRING to skip re-authentication, then delete the file.'
    );
  }

  const bridge = createTgToIgBridge(
    reader,
    mediaServer,
    store,
    {
      pollIntervalMs: config.pollIntervalSeconds * 1000,
      monitoredPeers: config.telegram.monitoredPeers,
      instagram: () => tokens.config(),
      quota,
    },
    logger
  );

  if (config.telegram.monitoredPeers.length === 0) {
    logger.warn('TELEGRAM_MONITORED_PEERS is empty — nothing will be bridged.');
  }

  bridge.start();
  logger.info(
    `Bridge running | poll ${config.pollIntervalSeconds}s | ` +
      `peers: ${config.telegram.monitoredPeers.length}`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    bridge.stop();
    tokens.stop();
    clearInterval(cleanupInterval);

    await mediaServer.stop().catch((error: Error) =>
      logger.error('Error stopping media server', { error: error.message })
    );
    await reader.disconnect().catch((error: Error) =>
      logger.error('Error disconnecting Telegram reader', { error: error.message })
    );

    store.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
