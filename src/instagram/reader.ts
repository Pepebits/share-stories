import { IgApiClient } from 'instagram-private-api';
import axios from 'axios';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from '../telegram/types.js';
import { InstagramStoryItem } from './types.js';

export async function getStoriesForUsers(
  ig: IgApiClient,
  usernames: string[],
  logger: Logger
): Promise<StoryMedia[]> {
  const results: StoryMedia[] = [];

  for (const username of usernames) {
    try {
      // Get the user's PK from their username
      const userId = await ig.user.getIdByUsername(username);

      // Fetch the user's story feed
      const storyFeed = ig.feed.userStory(userId);
      const stories = await storyFeed.items();

      logger.debug('Fetched stories for user', {
        username,
        userId,
        storyCount: stories.length,
      });

      for (const story of stories) {
        const item = story as any;
        const storyId = item.pk?.toString() || item.id?.toString();

        if (!storyId) continue;

        const mediaUrl = getBestMediaUrl(item);
        if (!mediaUrl) continue;

        try {
          const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
                'AppleWebKit/605.1.15',
            },
          });

          const mediaType = item.media_type === 1 ? 'photo' : 'video';
          const caption = item.caption?.text || `From Instagram: @${username}`;

          results.push({
            id: storyId,
            sourceUser: username,
            sourcePlatform: 'instagram',
            mediaType,
            buffer: Buffer.from(response.data),
            caption,
            timestamp: item.taken_at ? item.taken_at * 1000 : Date.now(),
            ...(mediaType === 'video'
              ? { duration: item.video_duration }
              : {}),
          });
        } catch (downloadErr) {
          logger.error('Failed to download Instagram story media', {
            storyId,
            username,
            error: downloadErr instanceof Error ? downloadErr.message : String(downloadErr),
          });
        }
      }
    } catch (error) {
      logger.error('Failed to get stories for user', {
        username,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function getBestMediaUrl(item: InstagramStoryItem): string | null {
  if (item.media_type === 1 && item.image_versions2?.candidates?.length) {
    // Photo: get the highest resolution candidate
    const candidates = [...item.image_versions2.candidates].sort(
      (a, b) => (b.width * b.height) - (a.width * a.height)
    );
    return candidates[0].url;
  }

  if (item.media_type === 2 && item.video_versions?.length) {
    // Video: get the highest resolution
    const versions = [...item.video_versions].sort(
      (a, b) => (b.width * b.height) - (a.width * a.height)
    );
    return versions[0].url;
  }

  return null;
}

export async function getReelsTray(
  ig: IgApiClient,
  logger: Logger
): Promise<Array<{ userId: string; username: string; hasStory: boolean }>> {
  try {
    const trayFeed = ig.feed.reelsTray();
    const trayItems = await trayFeed.items();

    return trayItems.map((item: any) => ({
      userId: item.user?.pk?.toString() || '',
      username: item.user?.username || '',
      hasStory: item.items?.length > 0 || item.has_new_story,
    }));
  } catch (error) {
    logger.error('Failed to get reels tray', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
