import { IgApiClient } from 'instagram-private-api';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from '../telegram/types.js';
import { withRetry } from '../utils/retry.js';

export async function postStory(
  ig: IgApiClient,
  media: StoryMedia,
  logger: Logger
): Promise<string> {
  logger.info('Posting story to Instagram', {
    sourceUser: media.sourceUser,
    mediaType: media.mediaType,
  });

  try {
    let result: any;

    if (media.mediaType === 'photo') {
      result = await withRetry(
        async () => {
          return ig.publish.story({
            file: media.buffer,
            caption: media.caption,
          });
        },
        {
          maxRetries: 2,
          baseDelayMs: 3000,
          maxDelayMs: 10000,
          logger,
          operation: 'instagram-publish-story-photo',
        }
      );
    } else {
      // For video stories, we need a cover image
      // Use a simple approach: first frame or a generated thumbnail
      result = await withRetry(
        async () => {
          return ig.publish.story({
            video: media.buffer,
            coverImage: media.buffer, // Instagram may use first frame
            caption: media.caption,
          });
        },
        {
          maxRetries: 2,
          baseDelayMs: 5000,
          maxDelayMs: 15000,
          logger,
          operation: 'instagram-publish-story-video',
        }
      );
    }

    const storyId = result?.media?.pk?.toString() || result?.media?.id?.toString() || 'unknown';
    logger.info('Story posted to Instagram successfully', { storyId });
    return storyId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to post story to Instagram via unofficial API', { error: message });
    throw new Error(`Instagram postStory failed: ${message}`);
  }
}
