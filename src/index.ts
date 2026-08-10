import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { StateStore } from './db/state.js';
import { createBot, setupCommands, getMe } from './telegram/bot.js';
import { TelegramStoryReader } from './telegram/reader.js';
import { createInstagramClient } from './instagram/client.js';
import { createTgToIgBridge } from './bridge/tg-to-ig.js';
import { createIgToTgBridge } from './bridge/ig-to-tg.js';
import { cleanupTempDir, ensureTempDir } from './bridge/media.js';

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Share Historys — Story Bridge        ║');
  console.log('║  Telegram ↔ Instagram Cross-Poster       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  let exitCode = 0;

  try {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);

    logger.info('Configuration loaded');

    // Initialize state store
    const store = new StateStore(config.databasePath);
    logger.info('State store initialized', { dbPath: config.databasePath });

    // Ensure temp directory
    await ensureTempDir(config.tempDir);

    // Start periodic temp cleanup (every 30 minutes)
    const cleanupInterval = setInterval(
      () => cleanupTempDir(config.tempDir, 3600000, logger),
      1800000
    );

    // --- Initialize Telegram Bot ---
    const bot = createBot(config.telegram.botToken, logger);
    const botUsername = await getMe(bot);
    await setupCommands(bot, logger);
    logger.info(`Telegram Bot ready: ${botUsername}`);

    // --- Initialize Instagram Client ---
    const ig = await createInstagramClient(
      config.instagram.username,
      config.instagram.password,
      config.instagram.sessionPath,
      logger
    );

    // --- Determine which bridges to start ---
    const startTgToIg =
      config.telegram.apiId > 0 &&
      config.telegram.apiHash.length > 0 &&
      config.telegram.monitoredPeers.length > 0;

    const startIgToTg =
      config.telegram.businessConnectionId.length > 0 &&
      config.instagram.monitoredUsers.length > 0;

    if (!startTgToIg && !startIgToTg) {
      logger.warn(
        'No bridges configured. Check your .env file:\n' +
          '  - TG→IG: set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_MONITORED_PEERS\n' +
          '  - IG→TG: set TELEGRAM_BUSINESS_CONNECTION_ID, INSTAGRAM_MONITORED_USERS'
      );
    }

    const bridges: Array<{ name: string; stop: () => void }> = [];

    // --- Telegram → Instagram Bridge ---
    if (startTgToIg) {
      let reader: TelegramStoryReader | null = null;

      try {
        reader = new TelegramStoryReader(
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
        logger.info(
          'GramJS session string (save this to TELEGRAM_SESSION_STRING):',
          { sessionString }
        );

        const tgToIg = createTgToIgBridge(
          reader,
          ig,
          store,
          {
            pollIntervalMs: config.pollIntervalSeconds * 1000,
            monitoredPeers: config.telegram.monitoredPeers,
            graphApiConfig: {
              appId: config.instagram.graphAppId,
              appSecret: config.instagram.graphAppSecret,
              accountId: config.instagram.graphAccountId,
              accessToken: config.instagram.graphAccessToken,
            },
          },
          logger
        );

        tgToIg.start();
        bridges.push({
          name: 'TG→IG',
          stop: () => {
            tgToIg.stop();
            reader?.disconnect();
          },
        });
      } catch (error) {
        logger.error('Failed to start TG→IG bridge', {
          error: error instanceof Error ? error.message : String(error),
        });
        await reader?.disconnect();
      }
    } else {
      logger.info(
        'TG→IG bridge SKIPPED: missing GramJS credentials or monitored peers'
      );
    }

    // --- Instagram → Telegram Bridge ---
    if (startIgToTg) {
      try {
        const igToTg = createIgToTgBridge(
          ig,
          bot,
          store,
          {
            pollIntervalMs: config.pollIntervalSeconds * 1000,
            monitoredUsers: config.instagram.monitoredUsers,
            businessConnectionId: config.telegram.businessConnectionId,
          },
          logger
        );

        igToTg.start();
        bridges.push({ name: 'IG→TG', stop: () => igToTg.stop() });
      } catch (error) {
        logger.error('Failed to start IG→TG bridge', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.info(
        'IG→TG bridge SKIPPED: missing business connection ID or monitored users'
      );
    }

    // --- Graceful Shutdown ---
    const shutdown = (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);

      for (const bridge of bridges) {
        try {
          bridge.stop();
          logger.info(`${bridge.name} bridge stopped`);
        } catch (err) {
          logger.error(`Error stopping ${bridge.name} bridge`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      clearInterval(cleanupInterval);
      store.close();
      logger.info('State store closed');
      logger.info('Shutdown complete');

      process.exit(exitCode);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    const activeBridges = bridges.map((b) => b.name).join(', ');
    logger.info(`All bridges running: ${activeBridges}`);
    logger.info(
      `Poll interval: ${config.pollIntervalSeconds}s | ` +
        `TG peers: ${config.telegram.monitoredPeers.length} | ` +
        `IG users: ${config.instagram.monitoredUsers.length}`
    );
  } catch (error) {
    console.error('Fatal startup error:', error);
    exitCode = 1;
    process.exit(exitCode);
  }
}

main();
