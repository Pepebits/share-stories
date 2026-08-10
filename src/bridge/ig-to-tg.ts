import TelegramBot from 'node-telegram-bot-api';
import { IgApiClient } from 'instagram-private-api';
import { getStoriesForUsers } from '../instagram/reader.js';
import { postStory as postToTelegram } from '../telegram/publisher.js';
import { StateStore } from '../db/state.js';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from '../telegram/types.js';

export interface IgToTgConfig {
  pollIntervalMs: number;
  monitoredUsers: string[];
  businessConnectionId: string;
}

export function createIgToTgBridge(
  ig: IgApiClient,
  bot: TelegramBot,
  store: StateStore,
  config: IgToTgConfig,
  logger: Logger
): { start: () => void; stop: () => void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const poll = async () => {
    if (!running) return;

    try {
      const stories = await getStoriesForUsers(
        ig,
        config.monitoredUsers,
        logger
      );

      for (const story of stories) {
        if (store.isProcessed(story.id, 'instagram', 'telegram')) {
          continue;
        }

        store.markProcessing(story.id, 'instagram', story.sourceUser, 'telegram');

        try {
          const targetStoryId = await postToTelegram(
            bot,
            config.businessConnectionId,
            story,
            {
              caption: story.caption,
            },
            logger
          );

          store.markPosted(story.id, 'instagram', 'telegram');
          logger.info('IG→TG story bridged', {
            from: story.id,
            to: targetStoryId,
            user: story.sourceUser,
          });
        } catch (error) {
          store.markFailed(
            story.id,
            'instagram',
            'telegram',
            error instanceof Error ? error.message : String(error)
          );
          logger.error('IG→TG bridge failed for story', {
            storyId: story.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.error('IG→TG poll cycle error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      logger.info('IG→TG bridge started', {
        users: config.monitoredUsers,
      });
      poll();
      interval = setInterval(poll, config.pollIntervalMs);
    },
    stop() {
      running = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      logger.info('IG→TG bridge stopped');
    },
  };
}
