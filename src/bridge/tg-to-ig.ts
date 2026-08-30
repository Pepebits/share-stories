import { TelegramStoryReader } from '../telegram/reader.js';
import { publishStory, PermanentError } from '../instagram/graph-api.js';
import { StateStore, MAX_ATTEMPTS } from '../db/state.js';
import { Logger } from '../utils/logger.js';
import { InstagramPublishConfig } from '../instagram/types.js';
import { QuotaGuard, QuotaExceededError } from '../instagram/quota.js';
import { MediaServer } from '../http/media-server.js';

export interface TgToIgConfig {
  pollIntervalMs: number;
  monitoredPeers: string[];
  quota: QuotaGuard;
  /**
   * Resolved per publish rather than captured once: the access token is
   * rotated in the background by TokenManager, and a captured copy would go
   * stale 60 days in without anything failing loudly.
   */
  instagram: () => InstagramPublishConfig;
}

export interface Bridge {
  start: () => void;
  stop: () => void;
}

export function createTgToIgBridge(
  reader: TelegramStoryReader,
  mediaServer: MediaServer,
  store: StateStore,
  config: TgToIgConfig,
  logger: Logger
): Bridge {
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // Publishing a video can outlast the poll interval; without this guard the
  // next tick would re-read the same stories and double-post them.
  let polling = false;

  const publish = async (story: Awaited<ReturnType<typeof reader.getStoriesForPeers>>[number]) => {
    store.markProcessing(story.id, 'telegram', story.sourceUser, 'instagram');

    try {
      const mediaId = await publishStory(story, config.instagram(), mediaServer, logger);
      config.quota.recordPublish();
      store.markPosted(story.id, 'telegram', 'instagram');
      logger.info('TG→IG story bridged', {
        from: story.id,
        to: mediaId,
        user: story.sourceUser,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markFailed(story.id, 'telegram', 'instagram', message);
      logger.error('TG→IG bridge failed for story', {
        storyId: story.id,
        error: message,
        permanent: error instanceof PermanentError,
      });

      // Said once, when it happens — the alternative is silence, and a story
      // that quietly stops being attempted is the kind of thing you find out
      // about days later.
      if (store.retryState(story.id, 'telegram', 'instagram') === 'exhausted') {
        logger.warn('Giving up on this story until it expires', {
          storyId: story.id,
          attempts: MAX_ATTEMPTS,
        });
      }
    }
  };

  const poll = async () => {
    if (!running || polling) return;
    polling = true;

    try {
      const stories = await reader.getStoriesForPeers(config.monitoredPeers);

      for (const story of stories) {
        if (!running) break;
        if (store.isProcessed(story.id, 'telegram', 'instagram')) continue;

        // A failed story is worth another go, but not on every cycle and not
        // forever: without this a story that cannot succeed is retried until
        // it expires, at three requests to Meta a time.
        const retry = store.retryState(story.id, 'telegram', 'instagram');
        if (retry !== 'ready') {
          logger.debug('Holding off on a failed story', { storyId: story.id, retry });
          continue;
        }

        try {
          // Checked before the story is touched: exceeding the quota is a
          // "come back later", not a failure, so the story must stay
          // unprocessed and be picked up again on a later cycle.
          await config.quota.ensureCapacity();
        } catch (error) {
          if (error instanceof QuotaExceededError) {
            logger.warn(`${error.message}. Pausing until the window frees up.`);
            break;
          }
          throw error;
        }

        await publish(story);
      }
    } catch (error) {
      logger.error('TG→IG poll cycle error', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      polling = false;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      logger.info('TG→IG bridge started', {
        peers: config.monitoredPeers,
        intervalMs: config.pollIntervalMs,
      });
      void poll();
      interval = setInterval(() => void poll(), config.pollIntervalMs);
    },
    stop() {
      running = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      logger.info('TG→IG bridge stopped');
    },
  };
}
