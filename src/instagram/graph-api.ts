import axios, { AxiosError } from 'axios';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from '../telegram/types.js';
import { InstagramPublishConfig, PublishTiming } from './types.js';
import { MediaServer } from '../http/media-server.js';
import { withRetry } from '../utils/retry.js';

/**
 * Official Instagram Content Publishing — "Instagram API with Instagram Login".
 *
 * Publishing a story is a three-step handshake:
 *   1. POST /<IG_ID>/media          → returns a container id
 *   2. GET  /<CONTAINER_ID>         → poll status_code until FINISHED
 *   3. POST /<IG_ID>/media_publish  → returns the published media id
 *
 * Meta downloads the media itself, so step 1 needs a publicly reachable URL.
 * See MediaServer for how that URL is produced and revoked.
 */

const API_VERSION = 'v25.0';
const DEFAULT_API_BASE = `https://graph.instagram.com/${API_VERSION}`;
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';

/**
 * Meta recommends polling once per minute for at most five minutes. Photos
 * usually finish within seconds, so start tighter and back off to that.
 */
export const DEFAULT_TIMING: PublishTiming = {
  pollDelaysMs: [2_000, 5_000, 10_000, 20_000, 30_000],
  pollTimeoutMs: 5 * 60_000,
  maxRetries: 2,
  retryBaseDelayMs: 3_000,
  retryMaxDelayMs: 15_000,
};

type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

/** Marker for failures that will not resolve on their own. */
export class PermanentError extends Error {
  readonly permanent = true;
}

const retryUnlessPermanent = (error: Error): boolean => !(error instanceof PermanentError);

const baseUrl = (config: InstagramPublishConfig): string =>
  (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');

const authHeaders = (config: InstagramPublishConfig) => ({
  Authorization: `Bearer ${config.accessToken}`,
});

export function isPublishConfigured(config: InstagramPublishConfig): boolean {
  return Boolean(config.accountId && config.accessToken);
}

/** Unwraps Meta's error envelope, which axios buries under response.data. */
function describeError(error: unknown): string {
  if (error instanceof AxiosError) {
    const metaError = error.response?.data?.error;
    if (metaError) {
      const parts = [metaError.message ?? 'unknown Graph API error'];
      if (metaError.code !== undefined) parts.push(`code=${metaError.code}`);
      if (metaError.error_subcode !== undefined) parts.push(`subcode=${metaError.error_subcode}`);
      if (metaError.fbtrace_id) parts.push(`fbtrace_id=${metaError.fbtrace_id}`);
      return parts.join(' ');
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * An access token or permission problem will fail identically on every retry,
 * so retrying only delays the log line that explains what to fix.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  const status = error.response?.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

function asPermanentIfHopeless(error: unknown): never {
  if (isPermanent(error)) throw new PermanentError(describeError(error));
  throw error;
}

async function createContainer(
  mediaUrl: string,
  media: StoryMedia,
  config: InstagramPublishConfig,
  timing: PublishTiming,
  logger: Logger
): Promise<string> {
  const payload: Record<string, string> = { media_type: 'STORIES' };

  if (media.mediaType === 'photo') {
    payload.image_url = mediaUrl;
  } else {
    payload.video_url = mediaUrl;
  }

  // Stories ignore the caption field — the text is only rendered on feed posts.
  if (media.caption) {
    logger.debug('Dropping caption: Instagram stories do not render one', {
      storyId: media.id,
    });
  }

  const response = await withRetry(
    async () => {
      try {
        return await axios.post(`${baseUrl(config)}/${config.accountId}/media`, payload, {
          headers: authHeaders(config),
          timeout: 30_000,
        });
      } catch (error) {
        asPermanentIfHopeless(error);
      }
    },
    {
      maxRetries: timing.maxRetries,
      baseDelayMs: timing.retryBaseDelayMs,
      maxDelayMs: timing.retryMaxDelayMs,
      logger,
      operation: 'instagram-create-container',
      shouldRetry: retryUnlessPermanent,
    }
  );

  const containerId = response?.data?.id;
  if (!containerId) {
    throw new Error('Graph API returned no container id');
  }

  logger.debug('Story container created', { containerId, storyId: media.id });
  return String(containerId);
}

async function waitForContainer(
  containerId: string,
  config: InstagramPublishConfig,
  timing: PublishTiming,
  logger: Logger
): Promise<void> {
  const deadline = Date.now() + timing.pollTimeoutMs;

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const delay = timing.pollDelaysMs[Math.min(attempt, timing.pollDelaysMs.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, delay));

    let status: ContainerStatus;
    try {
      const response = await axios.get(`${baseUrl(config)}/${containerId}`, {
        params: { fields: 'status_code' },
        headers: authHeaders(config),
        timeout: 15_000,
      });
      status = response.data?.status_code;
    } catch (error) {
      if (isPermanent(error)) {
        throw new PermanentError(describeError(error));
      }
      // A transient read failure should not abandon an otherwise healthy
      // container; keep polling until the deadline.
      logger.warn('Container status check failed, retrying', {
        containerId,
        error: describeError(error),
      });
      continue;
    }

    if (status === 'FINISHED' || status === 'PUBLISHED') {
      return;
    }

    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new PermanentError(
        `Container ${containerId} ended in status ${status}. ` +
          "Usually the media failed Meta's format checks, or PUBLIC_BASE_URL was unreachable."
      );
    }

    logger.debug('Container still processing', { containerId, status });
  }

  throw new Error(`Container ${containerId} did not finish before the publish timeout`);
}

async function publishContainer(
  containerId: string,
  config: InstagramPublishConfig,
  timing: PublishTiming,
  logger: Logger
): Promise<string> {
  const response = await withRetry(
    async () => {
      try {
        return await axios.post(
          `${baseUrl(config)}/${config.accountId}/media_publish`,
          { creation_id: containerId },
          { headers: authHeaders(config), timeout: 30_000 }
        );
      } catch (error) {
        asPermanentIfHopeless(error);
      }
    },
    {
      maxRetries: timing.maxRetries,
      baseDelayMs: timing.retryBaseDelayMs,
      maxDelayMs: timing.retryMaxDelayMs,
      logger,
      operation: 'instagram-media-publish',
      shouldRetry: retryUnlessPermanent,
    }
  );

  const mediaId = response?.data?.id;
  if (!mediaId) {
    throw new Error('Graph API returned no media id after publish');
  }
  return String(mediaId);
}

/**
 * Publish a story and return the published Instagram media id.
 */
export async function publishStory(
  media: StoryMedia,
  config: InstagramPublishConfig,
  mediaServer: MediaServer,
  logger: Logger,
  timing: PublishTiming = DEFAULT_TIMING
): Promise<string> {
  if (!isPublishConfigured(config)) {
    throw new PermanentError(
      'Instagram publishing is not configured. Set INSTAGRAM_ACCOUNT_ID and INSTAGRAM_ACCESS_TOKEN.'
    );
  }

  const hosted = mediaServer.host(media.buffer, media.mediaType);

  logger.info('Publishing story to Instagram', {
    storyId: media.id,
    sourceUser: media.sourceUser,
    mediaType: media.mediaType,
    bytes: media.buffer.length,
  });

  try {
    const containerId = await createContainer(hosted.url, media, config, timing, logger);
    await waitForContainer(containerId, config, timing, logger);
    const mediaId = await publishContainer(containerId, config, timing, logger);

    logger.info('Story published to Instagram', { storyId: media.id, mediaId });
    return mediaId;
  } catch (error) {
    const message = `Instagram publish failed: ${describeError(error)}`;
    throw error instanceof PermanentError ? new PermanentError(message) : new Error(message);
  } finally {
    // Revoke the URL whether we succeeded or not — Meta has no reason to
    // fetch it again, and a live URL is a leak of the media.
    hosted.release();
  }
}

/**
 * Long-lived tokens last 60 days and can be refreshed once they are at least
 * 24 hours old. Note this is the Instagram Login flow (`ig_refresh_token`),
 * not the Facebook Login flow (`fb_exchange_token`).
 */
export async function refreshAccessToken(
  config: InstagramPublishConfig,
  logger: Logger
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await axios.get(config.apiBase ? `${baseUrl(config)}/refresh` : REFRESH_URL, {
    params: { grant_type: 'ig_refresh_token', access_token: config.accessToken },
    timeout: 15_000,
  });

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error('Token refresh returned no access_token');
  }

  logger.info('Instagram access token refreshed', {
    expiresInDays: Math.round((response.data.expires_in ?? 0) / 86_400),
  });

  return { accessToken, expiresInSeconds: response.data.expires_in ?? 0 };
}

/**
 * Fetch the authenticated account, used at startup to prove the token works
 * before any story arrives.
 */
export async function getAccountInfo(
  config: InstagramPublishConfig,
  logger: Logger
): Promise<{ id: string; username: string } | null> {
  try {
    const response = await axios.get(`${baseUrl(config)}/${config.accountId}`, {
      params: { fields: 'id,username' },
      headers: authHeaders(config),
      timeout: 15_000,
    });
    return response.data;
  } catch (error) {
    logger.error('Could not verify Instagram credentials', { error: describeError(error) });
    return null;
  }
}
