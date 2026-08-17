import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFile } from 'node:fs/promises';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from './types.js';
import { isVideoBuffer } from '../bridge/media.js';
import { prompt } from '../utils/prompt.js';

/**
 * Reads active Telegram stories over MTProto.
 *
 * This needs a user account session, which is an unscoped credential for that
 * whole account — acceptable for your own machine, not for holding on behalf
 * of others. The Bot API is no substitute: it cannot see stories at all.
 *
 * The API surface here is untyped in GramJS, so the shapes below were taken
 * from live responses rather than from declarations.
 */

export interface TelegramReaderConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  sessionString: string;
  tempDir: string;
}

/** GramJS returns ids as BigInteger instances, not numbers. */
type PeerId = { toString(): string };

/** One entry per peer, each holding that peer's active stories. */
interface PeerStories {
  peer?: { userId?: PeerId; channelId?: PeerId; chatId?: PeerId };
  stories?: RawStory[];
}

interface RawStory {
  id?: number;
  date?: number;
  caption?: string | null;
  media?: unknown;
}

/** Telegram allows several usernames; the legacy field is null when it does. */
interface RawPeer {
  id: PeerId;
  username?: string | null;
  usernames?: { username?: string }[];
  title?: string;
  firstName?: string;
}

interface PeerNames {
  handles: string[];
  title?: string;
}

function namesOf(peer: RawPeer): PeerNames {
  const handles = [
    ...(peer.username ? [peer.username] : []),
    ...(peer.usernames ?? []).flatMap((u) => (u.username ? [u.username] : [])),
  ];
  return { handles, title: peer.title ?? peer.firstName };
}

export class TelegramStoryReader {
  private client: TelegramClient | null = null;

  constructor(
    private readonly config: TelegramReaderConfig,
    private readonly logger: Logger
  ) {}

  async connect(): Promise<string> {
    this.client = new TelegramClient(
      new StringSession(this.config.sessionString),
      this.config.apiId,
      this.config.apiHash,
      { connectionRetries: 5 }
    );

    await this.client.start({
      phoneNumber: this.config.phoneNumber,
      // Telegram sends these to the account's other devices when the session
      // is absent or stale. Without a terminal, prompt() refuses rather than
      // blocking on a stdin that will never deliver.
      phoneCode: () => prompt('Telegram login code: '),
      password: () => prompt('Telegram 2FA password: ', true),
      onError: (error: Error) => {
        this.logger.error('GramJS connection error', { error: error.message });
      },
    });

    const sessionString = this.client.session.save() as unknown as string;

    const me = (await this.client.getMe()) as unknown as RawPeer | undefined;
    this.logger.info('GramJS connected', {
      as: me ? (namesOf(me).handles[0] ?? me.firstName) : 'unknown',
    });

    return sessionString;
  }

  /**
   * Active stories from the given peers, which may be named by any active
   * username, by title, or by numeric id — private channels have nothing else.
   */
  async getStoriesForPeers(peers: string[]): Promise<StoryMedia[]> {
    if (!this.client) {
      throw new Error('Reader not connected. Call connect() first.');
    }

    const results: StoryMedia[] = [];

    let response: { peerStories?: PeerStories[]; users?: RawPeer[]; chats?: RawPeer[] };
    try {
      response = (await this.client.invoke(new Api.stories.GetAllStories({}))) as never;
    } catch (error) {
      this.logger.error('Failed to fetch Telegram stories', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const feed = response.peerStories ?? [];
    if (feed.length === 0) return results;

    this.logger.debug('Fetched stories from Telegram', {
      peers: feed.length,
      stories: feed.reduce((total, entry) => total + (entry.stories?.length ?? 0), 0),
    });

    const names = new Map<string, PeerNames>();
    for (const peer of [...(response.users ?? []), ...(response.chats ?? [])]) {
      names.set(peer.id.toString(), namesOf(peer));
    }

    const wanted = peers.map((p) => p.replace(/^@/, '').toLowerCase());

    for (const entry of feed) {
      const peerId =
        (entry.peer?.userId ?? entry.peer?.channelId ?? entry.peer?.chatId)?.toString() ?? '';
      const info = names.get(peerId);
      const label = info?.handles[0] ? `@${info.handles[0]}` : (info?.title ?? peerId);

      const matches = wanted.some(
        (w) =>
          w === peerId ||
          w === info?.title?.toLowerCase() ||
          (info?.handles ?? []).some((handle) => handle.toLowerCase() === w)
      );

      if (!matches) {
        this.logger.debug('Skipping unmonitored peer', { peer: label, peerId });
        continue;
      }

      for (const story of entry.stories ?? []) {
        try {
          const media = await this.toStoryMedia(story, label, peerId);
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

    return results;
  }

  private async toStoryMedia(
    story: RawStory,
    peerLabel: string,
    peerId: string
  ): Promise<StoryMedia | null> {
    if (!this.client || story.id === undefined) return null;

    // Story ids restart per peer — two channels can both own story 3 — and the
    // state store dedupes on this across every peer, so it must be qualified
    // or one of the two would silently never be published.
    const storyId = `${peerId}:${story.id}`;

    const buffer = await this.download(story, storyId);
    if (!buffer) {
      this.logger.warn('No media could be downloaded for story', { storyId });
      return null;
    }

    return {
      id: storyId,
      sourceUser: peerLabel,
      sourcePlatform: 'telegram',
      // Telegram delivers photos and videos alike as documents, so the bytes
      // are the only reliable signal.
      mediaType: isVideoBuffer(buffer) ? 'video' : 'photo',
      buffer,
      caption: story.caption ?? undefined,
      timestamp: story.date ? story.date * 1000 : Date.now(),
    };
  }

  /**
   * downloadMedia returns either a Buffer or a path, depending on size and
   * options, so both have to be handled. The story itself is tried as a
   * fallback because some story types carry the file outside `media`.
   */
  private async download(story: RawStory, storyId: string): Promise<Buffer | null> {
    const client = this.client;
    if (!client) return null;

    const attempt = async (target: unknown): Promise<Buffer | null> => {
      const downloaded = await client.downloadMedia(target as never, {});
      if (Buffer.isBuffer(downloaded)) return downloaded;
      if (typeof downloaded === 'string') return readFile(downloaded);
      return null;
    };

    try {
      if (story.media) {
        const fromMedia = await attempt(story.media);
        if (fromMedia) return fromMedia;
      }
      return await attempt(story);
    } catch (error) {
      this.logger.warn('Story media download failed', {
        storyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
    this.logger.info('GramJS disconnected');
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
