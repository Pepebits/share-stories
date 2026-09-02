import { StorySource, StoryMedia } from '../telegram/types.js';
import { publishStory, PermanentError } from '../instagram/graph-api.js';
import { StateStore, MAX_ATTEMPTS } from '../db/state.js';
import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { InstagramPublishConfig } from '../instagram/types.js';
import { QuotaGuard, QuotaExceededError } from '../instagram/quota.js';
import { MediaServer } from '../http/media-server.js';

/** Consecutive reconnect failures before the bridge gives up and exits. */
export const MAX_RECONNECT_FAILURES = 5;

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
  /**
   * Consecutive publish failures before the account is messaged. 0 disables
   * it. Counted across cycles, because the failure worth hearing about is the
   * one that keeps happening, not the one that resolves itself.
   */
  alertAfterFailures: number;
  /** Called once reconnecting has failed MAX_RECONNECT_FAILURES times in a row. */
  onFatal: (reason: string) => void;
}

export interface Bridge {
  start: () => void;
  stop: () => void;
}

export function createTgToIgBridge(
  reader: StorySource,
  mediaServer: MediaServer,
  store: StateStore,
  config: TgToIgConfig,
  logger: Logger
): Bridge {
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let consecutiveFailures = 0;
  let reconnectFailures = 0;
  // Edge-triggered: one message when things break, one when they come back,
  // and silence in between. A per-failure alert during an outage would be
  // noise, and noise is what stops being read.
  let alerted = false;
  // Publishing a video can outlast the poll interval; without this guard the
  // next tick would re-read the same stories and double-post them.
  let polling = false;

  /**
   * Whether a story is worth spending anything on right now — never published,
   * and not a failure that is waiting out its backoff or has been written off.
   */
  const worthAttempting = (storyId: string): boolean =>
    !store.isProcessed(storyId, 'telegram', 'instagram') &&
    store.retryState(storyId, 'telegram', 'instagram') === 'ready';

  const publish = async (story: StoryMedia) => {
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

      consecutiveFailures = 0;
      if (alerted) {
        alerted = false;
        void reader.notifySelf('✅ share-stories: publishing again, a story just went through.');
      }
    } catch (error) {
      const message = errorMessage(error);
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

      consecutiveFailures++;
      if (
        config.alertAfterFailures > 0 &&
        !alerted &&
        consecutiveFailures >= config.alertAfterFailures
      ) {
        alerted = true;
        void reader.notifySelf(
          `⚠️ share-stories: ${consecutiveFailures} stories in a row failed to publish.\n\n` +
            `Last error: ${message}`
        );
      }
    }
  };

  const poll = async () => {
    if (!running || polling) return;
    polling = true;

    try {
      if (!reader.isConnected()) {
        try {
          await reader.reconnect();
          reconnectFailures = 0;
          logger.info('Telegram reconnected');
        } catch (error) {
          reconnectFailures++;
          logger.warn('Telegram reconnect failed', {
            attempt: reconnectFailures,
            error: errorMessage(error),
          });
          if (reconnectFailures >= MAX_RECONNECT_FAILURES) {
            config.onFatal(`Telegram unreachable after ${reconnectFailures} reconnect attempts`);
          }
          return;
        }
      }

      // The reader downloads whatever it returns, so the "have we settled this
      // already?" question has to be answered before it fetches, not after.
      const stories = await reader.getStoriesForPeers(config.monitoredPeers, worthAttempting);

      for (const story of stories) {
        if (!running) break;

        // Asked again because the whole batch is downloaded before any of it
        // is published, and publishing a video can outlast a poll interval.
        if (!worthAttempting(story.id)) continue;

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
      logger.error('TG→IG poll cycle error', { error: errorMessage(error) });
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
