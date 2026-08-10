import TelegramBot from 'node-telegram-bot-api';
import type { InputStoryContent } from 'node-telegram-bot-api';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from './types.js';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';

export interface PostStoryOptions {
  caption?: string;
  activePeriod?: number; // 6*3600, 12*3600, 86400, 2*86400 (48h = Premium)
  postToChatPage?: boolean;
  protectContent?: boolean;
}

const DEFAULT_ACTIVE_PERIOD = 86400; // 24 hours

export async function postStory(
  bot: TelegramBot,
  businessConnectionId: string,
  media: StoryMedia,
  options: PostStoryOptions = {},
  logger: Logger
): Promise<number> {
  let content: InputStoryContent;

  if (media.mediaType === 'photo') {
    content = {
      type: 'photo',
      photo: media.buffer as unknown as string,
    };
  } else {
    content = {
      type: 'video',
      video: media.buffer as unknown as string,
    };
  }

  const activePeriod = options.activePeriod ?? DEFAULT_ACTIVE_PERIOD;

  try {
    logger.info('Posting story to Telegram', {
      businessConnectionId,
      mediaType: media.mediaType,
      sourceUser: media.sourceUser,
    });

    const result = await bot.postStory(businessConnectionId, content, activePeriod, {
      ...(options.caption ? { caption: options.caption } : {}),
      ...(options.postToChatPage !== undefined
        ? { post_to_chat_page: options.postToChatPage }
        : {}),
      ...(options.protectContent !== undefined
        ? { protect_content: options.protectContent }
        : {}),
    });

    logger.info('Story posted to Telegram successfully', { storyId: result.id });
    return result.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to post story to Telegram', { error: message });
    throw new Error(`Telegram postStory failed: ${message}`);
  }
}

export async function deleteStory(
  bot: TelegramBot,
  businessConnectionId: string,
  storyId: number,
  logger: Logger
): Promise<void> {
  try {
    await bot.deleteStory(businessConnectionId, storyId);
    logger.info('Story deleted from Telegram', { storyId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to delete Telegram story', { storyId, error: message });
    throw new Error(`Telegram deleteStory failed: ${message}`);
  }
}
