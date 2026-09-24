import { StorySource, StoryMedia } from '../telegram/types.js';
import { publishStory, PermanentError, PublishAbortedError } from '../instagram/graph-api.js';
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
   * Resolved per publish, not captured once: TokenManager rotates the token in the
   * background, and a captured copy would go stale 60 days in without failing loudly.
   */
  instagram: () => InstagramPublishConfig;
  /**
   * Consecutive publish failures before the account is messaged (0 disables it),
   * counted across cycles so a self-resolving blip does not trigger it.
   */
  alertAfterFailures: number;
  /** Called once reconnecting has failed MAX_RECONNECT_FAILURES times in a row. */
  onFatal: (reason: string) => void;
}

export interface Bridge {
  start: () => void;
  stop: () => Promise<void>;
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
  // Edge-triggered: one message when things break, one when they recover, silence in between.
  let alerted = false;
  // Guards against a poll tick overlapping a publish that outlasts the interval.
  let polling = false;
  let current: Promise<void> = Promise.resolve();
  // Aborted by stop() so a publish stuck waiting on its container does not block shutdown.
  // Replaced with a fresh one afterwards, since an AbortController can't be un-aborted for a
  // later start(). A publish already past that point ignores it — see graph-api.ts.
  let abortController = new AbortController();

  // Never published, and not a failure waiting out its backoff or written off.
  const worthAttempting = (storyId: string): boolean =>
    store.attemptState(storyId, 'telegram', 'instagram') === 'ready';

  const publish = async (story: StoryMedia) => {
    store.markProcessing(story.id, 'telegram', story.sourceUser, 'instagram');

    try {
      const mediaId = await publishStory(
        story,
        config.instagram(),
        mediaServer,
        logger,
        undefined,
        abortController.signal
      );
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
      // Cut short by stop(), not a real failure: media_publish was never sent,
      // so it must not cost an attempt, count toward consecutiveFailures, or trigger an alert —
      // it will simply be tried again, at no disadvantage, on the next boot.
      if (error instanceof PublishAbortedError) {
        store.markInterrupted(story.id, 'telegram', 'instagram', errorMessage(error));
        logger.info('TG→IG publish interrupted by shutdown; will retry next boot', {
          storyId: story.id,
        });
        return;
      }

      const message = errorMessage(error);
      store.markFailed(story.id, 'telegram', 'instagram', message);
      logger.error('TG→IG bridge failed for story', {
        storyId: story.id,
        error: message,
        permanent: error instanceof PermanentError,
      });

      // Logged once, so a story that quietly stops being attempted doesn't go unnoticed.
      if (store.attemptState(story.id, 'telegram', 'instagram') === 'exhausted') {
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

  /**
   * "Come back later", not a failure: exceeding the quota must leave the story unprocessed for
   * a later cycle, so QuotaExceededError is swallowed here (after being logged) rather than
   * left for the outer catch to report as a cycle error.
   */
  const capacityAvailable = async (): Promise<boolean> => {
    try {
      await config.quota.ensureCapacity();
      return true;
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        logger.warn(`${error.message}. Pausing until the window frees up.`);
        return false;
      }
      throw error;
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

      // Checked before the reader is asked for anything: without this, an exhausted quota was
      // only noticed after a story had already been downloaded for nothing, every single cycle.
      if (!(await capacityAvailable())) return;

      // The reader downloads whatever it yields, so "have we settled this already?" must be
      // answered before it fetches, not after.
      for await (const story of reader.stories(config.monitoredPeers, worthAttempting)) {
        if (!running) break;

        // Asked again since a peer's pending stories are all chosen before any download starts.
        if (!worthAttempting(story.id)) continue;

        // Re-checked per story: publishing consumes quota mid-cycle, so capacity can run out
        // partway through even though this cycle started with room to spare.
        if (!(await capacityAvailable())) break;

        await publish(story);
      }
    } catch (error) {
      logger.error('TG→IG poll cycle error', { error: errorMessage(error) });
    } finally {
      polling = false;
    }
  };

  // Only assigns `current` when a cycle actually starts, so stop() awaits the real one.
  const triggerPoll = () => {
    if (running && !polling) current = poll();
  };

  return {
    start() {
      if (running) return;
      running = true;
      logger.info('TG→IG bridge started', {
        peers: config.monitoredPeers,
        intervalMs: config.pollIntervalMs,
      });
      triggerPoll();
      interval = setInterval(triggerPoll, config.pollIntervalMs);
    },
    async stop() {
      running = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // Cuts a publish short if it's still waiting on its container; one already sending
      // media_publish finishes regardless (see graph-api.ts), so this can still take a moment.
      abortController.abort();
      await current;
      // A controller is single-use; swap in a fresh one in case start() runs again.
      abortController = new AbortController();
      logger.info('TG→IG bridge stopped');
    },
  };
}
