import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { readFile } from 'node:fs/promises';
import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { StoryMedia, StorySource } from './types.js';
import {
  namesOf,
  peerLabel,
  matchesPeer,
  describeTelegramMedia,
  isVideoBuffer,
  type RawPeer,
  type RawStory,
  type PeerNames,
} from './feed.js';
import { rejectionReason } from '../instagram/limits.js';
import { storyScope, isAllowed, type StoryScope } from './scope.js';
import { prompt, isInteractive } from '../utils/prompt.js';
import { TelegramSessionError, sessionLostError } from './session-error.js';
import { asSessionError } from './auth-errors.js';

// Re-exported so callers keep importing it from here; it lives apart so the bridge can test
// for it without loading the Telegram client.
export { TelegramSessionError };

/**
 * Reads active Telegram stories over MTProto with a user-account session — an unscoped
 * credential for the whole account, but the Bot API cannot see stories at all. teleproto (the maintained fork of
 * GramJS; sessions made with either load in both) types most of this surface, but the shapes in
 * feed.ts were taken from live responses and stay the contract.
 */

export interface TelegramReaderConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  sessionString: string;
  /** Story audiences that may be republished. See scope.ts for why. */
  allowedScopes: StoryScope[];
}

/** A peer is a user, a channel or a basic group; exactly one of these ids is set. */
function peerIdOf(peer: Api.TypePeer): string {
  if ('userId' in peer) return peer.userId.toString();
  if ('channelId' in peer) return peer.channelId.toString();
  return peer.chatId.toString();
}

export class TelegramStoryReader implements StorySource {
  private client: TelegramClient | null = null;
  // Kept beside the client because client.session is typed as the abstract Session, whose
  // save() may return void; StringSession.save() is known to return the string.
  private session: StringSession | null = null;

  constructor(
    private readonly config: TelegramReaderConfig,
    private readonly logger: Logger
  ) {}

  /** Shared by connect() and login(): a fresh, unconnected client seeded with this session. */
  private newClient(): TelegramClient {
    this.session = new StringSession(this.config.sessionString);
    return new TelegramClient(this.session, this.config.apiId, this.config.apiHash, {
      connectionRetries: 5,
    });
  }

  /** Logs which account this.client just authenticated as, once it is connected. */
  private async logConnected(): Promise<void> {
    if (!this.client) return;
    const me: RawPeer | undefined = await this.client.getMe();
    this.logger.info('Telegram connected', {
      as: me ? (namesOf(me).handles[0] ?? me.firstName) : 'unknown',
    });
  }

  /**
   * Connects with an existing session; never calls client.start(), which on a
   * revoked session sends a login code to the account's other devices and
   * loops in signInUser (teleproto/client/auth.js) until onError returns true.
   */
  async connect(): Promise<string> {
    this.client = this.newClient();

    try {
      await this.client.connect();

      if (!(await this.client.isUserAuthorized())) throw sessionLostError();

      const sessionString = this.session?.save() ?? '';
      await this.logConnected();
      return sessionString;
    } catch (error) {
      // isUserAuthorized() is the usual detector, but a revoked key can also surface as a typed
      // RPC error from connect() or getMe(); both end the same way, with the login hint.
      const lost = asSessionError(error);
      if (!lost) throw error;

      const client = this.client;
      this.client = null;
      await client.disconnect().catch(() => {});
      throw lost;
    }
  }

  /** First-run interactive authentication. See scripts/telegram-login.ts. */
  async login(): Promise<string> {
    this.client = this.newClient();

    await this.client.start({
      phoneNumber: this.config.phoneNumber,
      // Telegram sends these to the account's other devices when the session is stale;
      // without a terminal, prompt() refuses rather than blocking on stdin forever.
      phoneCode: () => prompt('Telegram login code: '),
      password: () => prompt('Telegram 2FA password: ', true),
      // teleproto-only: when the account has no login email, Telegram may require setting one
      // up before it sends the phone code (GramJS just failed here). Without these callbacks
      // start() throws instead of asking. Only the typed-code path is offered; the Google and
      // Apple sign-in tokens the API allows cannot be produced at a terminal.
      emailAddress: () => prompt('Telegram login email (Telegram requires one): '),
      emailVerification: async (options) => ({
        type: 'code',
        code: await prompt(`Code sent to ${options.emailPattern ?? 'your email'}: `),
      }),
      onError: (error: Error): Promise<boolean> => {
        this.logger.error('Telegram connection error', { error: error.message });
        // At a terminal teleproto asks again; without one, returning true stops it instead of looping.
        return Promise.resolve(!isInteractive());
      },
    });

    const sessionString = this.session?.save() ?? '';
    await this.logConnected();
    return sessionString;
  }

  async reconnect(): Promise<void> {
    if (!this.client) {
      throw new Error('Reader not connected. Call connect() first.');
    }
    try {
      await this.client.connect();
    } catch (error) {
      // A revoked session is not a network problem; the bridge must not retry it as one.
      throw asSessionError(error) ?? error;
    }
  }

  /**
   * Active stories for the given peers, named by username, title, or id. `isWanted` filters
   * before anything is downloaded — a story stays visible 24h, so without it every poll
   * would re-fetch it.
   */
  async *stories(
    peers: string[],
    isWanted: (storyId: string) => boolean = () => true
  ): AsyncIterable<StoryMedia> {
    if (!this.client) {
      throw new Error('Reader not connected. Call connect() first.');
    }

    let response: Api.stories.TypeAllStories;
    try {
      response = await this.client.invoke(new Api.stories.GetAllStories({}));
    } catch (error) {
      this.logger.error('Failed to fetch Telegram stories', { error: errorMessage(error) });
      throw asSessionError(error) ?? error;
    }

    // AllStoriesNotModified carries no feed at all; with no state token sent it should not
    // occur, but it is in the typings, so it reads as "nothing new".
    if (!('peerStories' in response)) return;

    const feed = response.peerStories;
    if (feed.length === 0) return;

    this.logger.debug('Fetched stories from Telegram', {
      peers: feed.length,
      stories: feed.reduce((total, entry) => total + entry.stories.length, 0),
    });

    const names = new Map<string, PeerNames>();
    const known: RawPeer[] = [...response.users, ...response.chats];
    for (const peer of known) {
      names.set(peer.id.toString(), namesOf(peer));
    }

    for (const entry of feed) {
      const peerId = peerIdOf(entry.peer);
      const info = names.get(peerId);
      const label = peerLabel(peerId, info);

      if (!matchesPeer(peers, peerId, info)) {
        this.logger.debug('Skipping unmonitored peer', { peer: label, peerId });
        continue;
      }

      // Asked before resolveSkipped, so an already-published story costs neither a fetch nor
      // a download.
      const pending: RawStory[] = entry.stories.filter(
        (story) => story.id !== undefined && isWanted(`${peerId}:${story.id}`)
      );

      if (pending.length === 0) {
        this.logger.debug('Nothing new for peer', { peer: label });
        continue;
      }

      for (const story of await this.resolveSkipped(entry.peer, pending, label)) {
        try {
          const media = await this.toStoryMedia(story, label, peerId);
          if (media) yield media;
        } catch (error) {
          this.logger.error('Failed to download story media', {
            storyId: story.id,
            peer: label,
            error: errorMessage(error),
          });
        }
      }
    }
  }

  /**
   * Replaces StoryItemSkipped placeholders with the real story. downloadMedia
   * doesn't fail on one — it resolves to an empty buffer — so without this
   * every skipped story would reach Instagram as a zero-byte file.
   */
  private async resolveSkipped(
    peer: Api.TypePeer | undefined,
    stories: RawStory[],
    peerLabel: string
  ): Promise<RawStory[]> {
    const client = this.client;
    if (!client) return stories;

    // Deleted stories are holes in the numbering; there is nothing to fetch.
    const skipped = stories.filter(
      (story) => story.className === 'StoryItemSkipped' && story.id !== undefined
    );
    if (skipped.length === 0) return stories;

    try {
      if (!peer) return stories;
      const full = await client.invoke(
        new Api.stories.GetStoriesByID({
          peer: await client.getInputEntity(peer),
          id: skipped.map((story) => story.id as number),
        })
      );

      const resolved = new Map<number | undefined, RawStory>(
        full.stories.map((story) => [story.id, story])
      );

      this.logger.debug('Resolved skipped stories', {
        peer: peerLabel,
        requested: skipped.length,
        resolved: resolved.size,
      });

      return stories.map((story) => resolved.get(story.id) ?? story);
    } catch (error) {
      // Leaving them unresolved is safe: toStoryMedia drops the placeholder className before
      // downloading anything.
      this.logger.warn('Could not resolve skipped stories; they are ignored this cycle', {
        peer: peerLabel,
        count: skipped.length,
        error: errorMessage(error),
      });
      return stories;
    }
  }

  private async toStoryMedia(
    story: RawStory,
    peerLabel: string,
    peerId: string
  ): Promise<StoryMedia | null> {
    if (!this.client || story.id === undefined) return null;

    // Anything still not a full StoryItem could not be resolved above, and has no media.
    if (story.className && story.className !== 'StoryItem') {
      this.logger.debug('Skipping story that carries no media', {
        storyId: `${peerId}:${story.id}`,
        className: story.className,
      });
      return null;
    }

    // Story ids restart per peer, and the state store dedupes across every peer, so this must
    // be qualified with the peer id or two identically-numbered stories would never both publish.
    const storyId = `${peerId}:${story.id}`;

    // Instagram cannot publish to a restricted audience — a close-friends story would arrive in
    // front of every follower. Declining it is the only way to honour the author's intent;
    // TELEGRAM_STORY_SCOPES decides which audiences are carried.
    const scope = storyScope(story);
    if (!isAllowed(scope, this.config.allowedScopes)) {
      this.logger.info('Skipping story: its audience does not survive the crossing', {
        storyId,
        scope,
        allowed: this.config.allowedScopes,
      });
      return null;
    }

    // Forwarding disabled is a weaker signal than the audience flags, but it points the same way.
    if (story.noforwards) {
      this.logger.info('Skipping story: the author disabled forwarding', { storyId });
      return null;
    }

    // Telegram states the size and duration up front, so a story Instagram would refuse can be
    // dropped before downloading it.
    const facts = describeTelegramMedia(story.media);
    const refusal = rejectionReason(facts);
    if (refusal) {
      this.logger.warn('Skipping a story Instagram would refuse', { storyId, reason: refusal });
      return null;
    }

    const buffer = await this.download(story, storyId);
    if (!buffer) {
      this.logger.warn('No media could be downloaded for story', { storyId });
      return null;
    }

    return {
      id: storyId,
      sourceUser: peerLabel,
      // Telegram delivers photos and videos alike as documents, so the bytes are the only
      // reliable signal of which this is.
      mediaType: isVideoBuffer(buffer) ? 'video' : 'photo',
      buffer,
      durationSeconds: facts.durationSeconds,
      caption: story.caption ?? undefined,
      timestamp: story.date ? story.date * 1000 : Date.now(),
    };
  }

  /**
   * downloadMedia returns a Buffer or a path depending on size, so both are handled;
   * the story itself is a fallback since some types carry the file outside `media`.
   */
  private async download(story: RawStory, storyId: string): Promise<Buffer | null> {
    const client = this.client;
    if (!client) return null;

    // Buffer.alloc(0) is truthy, so an empty download is normalised to null here —
    // otherwise it would satisfy every caller's `if (buffer)` and defeat the fallback below.
    const notEmpty = (buffer: Buffer): Buffer | null => (buffer.length > 0 ? buffer : null);

    const attempt = async (target: unknown): Promise<Buffer | null> => {
      // Kept: downloadMedia is typed for a Message or message media, but a story (and its
      // `media`, held as unknown in RawStory) is deliberately passed too — see the fallback below.
      const downloaded = await client.downloadMedia(target as never, {});
      if (Buffer.isBuffer(downloaded)) return notEmpty(downloaded);
      if (typeof downloaded === 'string') return notEmpty(await readFile(downloaded));
      return null;
    };

    try {
      if (story.media) {
        const fromMedia = await attempt(story.media);
        if (fromMedia) return fromMedia;
      }
      return await attempt(story);
    } catch (error) {
      this.logger.warn('Story media download failed', { storyId, error: errorMessage(error) });
      return null;
    }
  }

  /**
   * Alerts to the account's own Saved Messages: this runs unattended, and a failure
   * only the log records goes unnoticed. Telegram is already authenticated here.
   */
  async notifySelf(text: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.sendMessage('me', { message: text });
      this.logger.debug('Alert sent to Saved Messages');
    } catch (error) {
      // An alert that cannot be delivered must not take down the bridge trying to report it.
      this.logger.warn('Could not deliver the alert to Saved Messages', {
        error: errorMessage(error),
      });
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
    this.logger.info('Telegram disconnected');
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
