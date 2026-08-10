import { TelegramStoryReader } from '../telegram/reader.js';
import { postStory } from '../instagram/publisher.js';
import { postStoryViaGraphApi, isGraphApiConfigured } from '../instagram/graph-api.js';
import { StateStore } from '../db/state.js';
import { Logger } from '../utils/logger.js';
import { StoryMedia, BridgeResult } from '../telegram/types.js';
import { GraphApiConfig } from '../instagram/types.js';
import { IgApiClient } from 'instagram-private-api';

export interface TgToIgConfig {
  pollIntervalMs: number;
  monitoredPeers: string[];
  graphApiConfig: GraphApiConfig;
}

export async function runTgToIgBridge(
  reader: TelegramStoryReader,
  ig: IgApiClient,
  store: StateStore,
  config: TgToIgConfig,
  logger: Logger
): Promise<void> {
  logger.info('Starting Telegram → Instagram bridge', {
    peers: config.monitoredPeers,
    intervalMs: config.pollIntervalMs,
  });

  const poll = async () => {
    try {
      const stories = await reader.getStoriesForPeers(config.monitoredPeers);

      for (const story of stories) {
        if (store.isProcessed(story.id, 'telegram', 'instagram')) {
          logger.debug('Skipping already processed story', { storyId: story.id });
          continue;
        }

        store.markProcessing(story.id, 'telegram', story.sourceUser, 'instagram');

        try {
          let targetStoryId: string;

          // Hybrid: try Graph API first, fall back to unofficial
          if (isGraphApiConfigured(config.graphApiConfig)) {
            try {
              targetStoryId = await postStoryViaGraphApi(
                story,
                config.graphApiConfig,
                logger
              );
            } catch (graphErr) {
              logger.info('Graph API failed, falling back to unofficial API');
              targetStoryId = await postStory(ig, story, logger);
            }
          } else {
            targetStoryId = await postStory(ig, story, logger);
          }

          store.markPosted(story.id, 'telegram', 'instagram');
          logger.info('Telegram → Instagram: story bridged successfully', {
            telegramStoryId: story.id,
            instagramStoryId: targetStoryId,
            sourceUser: story.sourceUser,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          store.markFailed(story.id, 'telegram', 'instagram', errorMessage);
          logger.error('Telegram → Instagram: failed to bridge story', {
            storyId: story.id,
            error: errorMessage,
          });
        }
      }
    } catch (error) {
      logger.error('Telegram → Instagram: poll error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Run immediately, then on interval
  await poll();
  const interval = setInterval(poll, config.pollIntervalMs);

  // Return cleanup function via an unref mechanism
  interval.unref();
}

export function createTgToIgBridge(
  reader: TelegramStoryReader,
  ig: IgApiClient,
  store: StateStore,
  config: TgToIgConfig,
  logger: Logger
): { start: () => void; stop: () => void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const poll = async () => {
    if (!running) return;

    try {
      const stories = await reader.getStoriesForPeers(config.monitoredPeers);

      for (const story of stories) {
        if (store.isProcessed(story.id, 'telegram', 'instagram')) {
          continue;
        }

        store.markProcessing(story.id, 'telegram', story.sourceUser, 'instagram');

        try {
          let targetStoryId: string;

          if (isGraphApiConfigured(config.graphApiConfig)) {
            try {
              targetStoryId = await postStoryViaGraphApi(
                story,
                config.graphApiConfig,
                logger
              );
            } catch {
              targetStoryId = await postStory(ig, story, logger);
            }
          } else {
            targetStoryId = await postStory(ig, story, logger);
          }

          store.markPosted(story.id, 'telegram', 'instagram');
          logger.info('TG→IG story bridged', {
            from: story.id,
            to: targetStoryId,
            user: story.sourceUser,
          });
        } catch (error) {
          store.markFailed(
            story.id,
            'telegram',
            'instagram',
            error instanceof Error ? error.message : String(error)
          );
          logger.error('TG→IG bridge failed for story', {
            storyId: story.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.error('TG→IG poll cycle error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      logger.info('TG→IG bridge started');
      poll(); // Run first poll immediately
      interval = setInterval(poll, config.pollIntervalMs);
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
