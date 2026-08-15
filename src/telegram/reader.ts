import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from './types.js';
import { isVideoBuffer } from '../bridge/media.js';
import { prompt } from '../utils/prompt.js';
import { createHash } from 'crypto';

export interface TelegramReaderConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  sessionString: string;
  tempDir: string;
}

export class TelegramStoryReader {
  private client: TelegramClient | null = null;
  private config: TelegramReaderConfig;
  private logger: Logger;

  constructor(config: TelegramReaderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<string> {
    const session = this.config.sessionString
      ? new StringSession(this.config.sessionString)
      : new StringSession('');

    this.client = new TelegramClient(
      session,
      this.config.apiId,
      this.config.apiHash,
      {
        connectionRetries: 5,
      }
    );

    await this.client.start({
      phoneNumber: this.config.phoneNumber,
      // Telegram sends this to the account's other devices when the session
      // string is absent or stale. Without a terminal, prompt() refuses
      // rather than blocking on stdin forever.
      phoneCode: () => prompt('Telegram login code: '),
      password: () => prompt('Telegram 2FA password: ', true),
      onError: (err: Error) => {
        this.logger.error('GramJS connection error', { error: err.message });
      },
    });

    const sessionString = this.client.session.save() as unknown as string;
    this.logger.info('GramJS connected successfully');

    const me = await this.client.getMe();
    if (me) {
      this.logger.info('GramJS authenticated as', {
        username: (me as any).username,
        phone: (me as any).phone,
      });
    }

    return sessionString;
  }

  async getStoriesForPeers(usernames: string[]): Promise<StoryMedia[]> {
    if (!this.client) {
      throw new Error('Reader not connected. Call connect() first.');
    }

    const results: StoryMedia[] = [];

    try {
      // First, get all active stories
      const allStories = await this.client.invoke(
        new Api.stories.GetAllStories({})
      );

      if (!allStories || !(allStories as any).stories) {
        this.logger.debug('No active stories found');
        return results;
      }

      const storiesData = allStories as any;
      const stories = storiesData.stories || [];
      const users = storiesData.users || [];
      const chats = storiesData.chats || [];

      this.logger.debug('Fetched stories from Telegram', {
        storyCount: stories.length,
        userCount: users.length,
        chatCount: chats.length,
      });

      // Build a map of peer ID → username
      const peerMap = new Map<string, string>();
      for (const user of users) {
        if (user.username) {
          peerMap.set(user.id.toString(), user.username.toLowerCase());
        }
      }
      for (const chat of chats) {
        if (chat.username) {
          peerMap.set(chat.id.toString(), chat.username.toLowerCase());
        }
      }

      const targetUsernames = usernames.map((u) => u.replace('@', '').toLowerCase());

      // Filter stories from monitored peers
      for (const story of stories) {
        const peerId = story.peerId?.userId?.toString() || story.peerId?.chatId?.toString() || '';
        const peerUsername = peerMap.get(peerId);

        if (!peerUsername || !targetUsernames.includes(peerUsername)) {
          continue;
        }

        try {
          const media = await this.downloadStoryMedia(story, peerUsername);

          if (media) {
            results.push(media);
          }
        } catch (error) {
          this.logger.error('Failed to download story media', {
            storyId: story.id,
            peer: peerUsername,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to fetch Telegram stories', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return results;
  }

  private async downloadStoryMedia(
    story: any,
    peerUsername: string
  ): Promise<StoryMedia | null> {
    if (!this.client) return null;

    // Determine story ID and media
    const storyId = story.id?.toString() || createHash('md5')
      .update(`${peerUsername}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    let mediaBuffer: Buffer | null = null;
    // Telegram carries the story's own text here; it used to be declared and
    // never read, so every story fell through to the generic label below.
    const caption: string | undefined =
      typeof story.caption === 'string' && story.caption.length > 0
        ? story.caption
        : undefined;

    // Try to download the story media
    try {
      // Stories can contain photo or video
      if (story.media) {
        const downloaded = await this.client.downloadMedia(story.media, {});
        if (Buffer.isBuffer(downloaded)) {
          mediaBuffer = downloaded;
        } else if (typeof downloaded === 'string') {
          // It returned a file path
          const { readFile } = await import('fs/promises');
          mediaBuffer = await readFile(downloaded);
        }
      }

      if (!mediaBuffer) {
        // Fallback: try downloading via the story document
        const rawDownload = await this.client.downloadMedia(story, {});
        if (typeof rawDownload === 'string') {
          const { readFile } = await import('fs/promises');
          mediaBuffer = await readFile(rawDownload);
        } else if (Buffer.isBuffer(rawDownload)) {
          mediaBuffer = rawDownload;
        }
        if (!Buffer.isBuffer(mediaBuffer)) {
          mediaBuffer = null;
        }
      }
    } catch (err) {
      this.logger.warn('Could not download story via media field, trying alternatives', {
        storyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!mediaBuffer || !Buffer.isBuffer(mediaBuffer)) {
      this.logger.warn('No media could be downloaded for story', { storyId });
      return null;
    }

    const mediaType: 'photo' | 'video' = isVideoBuffer(mediaBuffer) ? 'video' : 'photo';

    return {
      id: storyId,
      sourceUser: peerUsername,
      sourcePlatform: 'telegram',
      mediaType,
      buffer: mediaBuffer,
      caption: caption || `From Telegram: @${peerUsername}`,
      timestamp: story.date ? story.date * 1000 : Date.now(),
    };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      this.logger.info('GramJS disconnected');
    }
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
