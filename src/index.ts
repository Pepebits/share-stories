import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { StateStore } from './db/state.js';
import { TelegramStoryReader, TelegramSessionError } from './telegram/reader.js';
import { writeSession } from './telegram/session.js';
import { getAccountInfo } from './instagram/graph-api.js';
import { TokenManager, DEFAULT_TOKEN_OPTIONS } from './instagram/token-manager.js';
import { QuotaGuard } from './instagram/quota.js';
import { MediaServer } from './http/media-server.js';
import { createTgToIgBridge } from './bridge/tg-to-ig.js';
import { cleanupTempDir, ensureTempDir } from './bridge/media.js';

const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;
const MAINTENANCE_INTERVAL_MS = 30 * 60_000;
const STORY_HISTORY_DAYS = 30;

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

  // Only one process owns this database, so anything still marked in-flight
  // is the residue of a crash. Left alone it would block that story forever.
  const stalled = store.recoverStalled();
  if (stalled > 0) {
    logger.warn(`Recovered ${stalled} story(ies) interrupted by a previous run; they will retry.`);
  }

  await ensureTempDir(config.tempDir);

  const runMaintenance = () => {
    void cleanupTempDir(config.tempDir, TEMP_FILE_MAX_AGE_MS, logger);
    const removed = store.cleanup(STORY_HISTORY_DAYS);
    if (removed > 0) logger.debug(`Purged ${removed} story record(s) older than ${STORY_HISTORY_DAYS} days`);
  };
  runMaintenance();
  const maintenanceInterval = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);

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

  const reader = new TelegramStoryReader(
    {
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      phoneNumber: config.telegram.phoneNumber,
      sessionString: config.telegram.sessionString,
      tempDir: config.tempDir,
      allowedScopes: config.telegram.allowedScopes,
    },
    logger
  );

  // Connected before anything starts listening: if the session is no good,
  // better to have opened nothing at all.
  const sessionString = await reader.connect();

  if (sessionString !== config.telegram.sessionString) {
    writeSession(config.telegram.sessionFile, sessionString);
    logger.info('Telegram session updated', { path: config.telegram.sessionFile });
    if (process.env.TELEGRAM_SESSION_STRING) {
      logger.warn(
        'TELEGRAM_SESSION_STRING in the environment is now stale; remove it and the session ' +
          'file will be used.'
      );
    }
  }

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
      isHealthy: () => reader.isConnected(),
    },
    logger
  );
  await mediaServer.start();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    bridge.stop();
    tokens.stop();
    clearInterval(maintenanceInterval);

    await mediaServer.stop().catch((error: Error) =>
      logger.error('Error stopping media server', { error: error.message })
    );
    await reader.disconnect().catch((error: Error) =>
      logger.error('Error disconnecting Telegram reader', { error: error.message })
    );

    store.close();
    logger.info('Shutdown complete');
    process.exit(exitCode);
  };

  const bridge = createTgToIgBridge(
    reader,
    mediaServer,
    store,
    {
      pollIntervalMs: config.pollIntervalSeconds * 1000,
      monitoredPeers: config.telegram.monitoredPeers,
      instagram: () => tokens.config(),
      alertAfterFailures: config.alertAfterFailures,
      quota,
      onFatal: (reason) => {
        logger.error(reason);
        void shutdown('fatal', 1);
      },
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

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof TelegramSessionError) {
    console.error(error.message);
  } else {
    console.error('Fatal startup error:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
