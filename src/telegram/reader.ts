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
      const response = (await this.client.invoke(new Api.stories.GetAllStories({}))) as any;

      // The API returns peerStories: one entry per peer, each holding that
      // peer's active stories. It is not a flat list, and the peer lives on
      // the entry rather than on the individual story.
      const feed = response?.peerStories ?? [];
      const users = response?.users ?? [];
      const chats = response?.chats ?? [];

      this.logger.debug('Fetched stories from Telegram', {
        peers: feed.length,
        stories: feed.reduce((n: number, e: any) => n + (e.stories?.length ?? 0), 0),
      });

      if (feed.length === 0) return results;

      // A peer must be addressable several ways:
      //  - Telegram supports multiple usernames, and when it does the legacy
      //    `username` field is null while the real ones sit in `usernames[]`.
      //  - Channels frequently have no username at all, only a title.
      //  - Private channels have neither, leaving just the numeric id.
      const collectNames = (peer: any): { handles: string[]; title?: string } => {
        const handles: string[] = [];
        if (peer.username) handles.push(peer.username);
        for (const entry of peer.usernames ?? []) {
          if (entry?.username) handles.push(entry.username);
        }
        return { handles, title: peer.title ?? peer.firstName };
      };

      const names = new Map<string, { handles: string[]; title?: string }>();
      for (const peer of [...users, ...chats]) {
        names.set(peer.id.toString(), collectNames(peer));
      }

      const wanted = usernames.map((u) => u.replace(/^@/, '').toLowerCase());

      for (const entry of feed) {
        const peerId = String(
          entry.peer?.userId ?? entry.peer?.channelId ?? entry.peer?.chatId ?? ''
        );
        const info = names.get(peerId);
        const label = info?.handles[0] ? `@${info.handles[0]}` : (info?.title ?? peerId);

        const matches = wanted.some(
          (w) =>
            w === peerId ||
            w === info?.title?.toLowerCase() ||
            (info?.handles ?? []).some((h) => h.toLowerCase() === w)
        );

        if (!matches) {
          this.logger.debug('Skipping unmonitored peer', { peer: label, peerId });
          continue;
        }

        for (const story of entry.stories ?? []) {
          try {
            const media = await this.downloadStoryMedia(story, label, peerId);
            if (media) results.push(media);
          } catch (error) {
            this.logger.error('Failed to download story media', {
              storyId: story.id,
              peer: label,
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
    peerUsername: string,
    peerId: string
  ): Promise<StoryMedia | null> {
    if (!this.client) return null;

    // Story ids restart per peer — two channels can both have story 3 — and
    // the state store dedupes on this value across every peer, so it has to
    // be qualified or one of the two would silently never be posted.
    const storyId = story.id
      ? `${peerId}:${story.id}`
      : `${peerId}:${createHash('md5').update(`${peerUsername}-${String(story.date)}`).digest('hex').substring(0, 16)}`;

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
