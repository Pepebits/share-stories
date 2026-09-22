import axios, { AxiosError } from 'axios';
import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { StoryMedia } from '../telegram/types.js';
import { InstagramPublishConfig, PublishTiming } from './types.js';
import { MediaServer } from '../http/media-server.js';
import { withRetry } from '../utils/retry.js';
import { rejectionReason } from './limits.js';

/**
 * Official Instagram Content Publishing — "Instagram API with Instagram Login".
 * Publishing a story is a three-step handshake: create a container (POST
 * /media), poll it until FINISHED (GET /<id>), then publish it (POST
 * /media_publish). Meta downloads the media itself, so step 1 needs a
 * publicly reachable URL — see MediaServer for how it is produced.
 */

// Verified against the live API: v26 behaves identically to v25 for these endpoints.
const API_VERSION = 'v26.0';
const DEFAULT_API_BASE = `https://graph.instagram.com/${API_VERSION}`;
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';

// Meta recommends polling once per minute for at most five minutes; photos usually finish
// within seconds, so start tighter and back off to that.
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

    // A 5xx from Meta often arrives without that envelope, so carry whatever body came back.
    const body = error.response?.data;
    if (error.response && body) {
      const rendered = typeof body === 'string' ? body : JSON.stringify(body);
      if (rendered && rendered !== '{}') {
        return `${error.message} — ${rendered.slice(0, 300)}`;
      }
    }
    return error.message;
  }
  return errorMessage(error);
}

// Meta reports rate limiting and other transient conditions as an ordinary 400 or 403 rather
// than 429 or a 5xx: application request limit, API too many calls, temporary block/OAuth
// issue, and pending/reduced-capacity codes. Retrying these behaves the same as a 5xx.
const TRANSIENT_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * An access token or permission problem will fail identically on every retry,
 * so retrying only delays the log line that explains what to fix.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  const status = error.response?.status;
  if (status === undefined || status < 400 || status >= 500 || status === 429) return false;

  const metaError = error.response?.data?.error;
  if (metaError?.is_transient === true) return false;
  if (typeof metaError?.code === 'number' && TRANSIENT_ERROR_CODES.has(metaError.code)) {
    return false;
  }

  return true;
}

function asPermanentIfHopeless(error: unknown): never {
  if (isPermanent(error)) throw new PermanentError(describeError(error));
  // withRetry logs whatever message it is given, so it must be the described one, not
  // axios's bare status line.
  throw error instanceof AxiosError ? new Error(describeError(error)) : error;
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

/** The status poll shared by waitForContainer and the lost-response check in publishContainer. */
async function readContainerStatus(
  containerId: string,
  config: InstagramPublishConfig
): Promise<{ status?: ContainerStatus; detail?: string }> {
  const response = await axios.get(`${baseUrl(config)}/${containerId}`, {
    params: { fields: 'status_code,status' },
    headers: authHeaders(config),
    timeout: 15_000,
  });
  // `status` carries Meta's own sentence about what went wrong; status_code alone only
  // ever says ERROR.
  return { status: response.data?.status_code, detail: response.data?.status };
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

    let status: ContainerStatus | undefined;
    let detail: string | undefined;
    try {
      ({ status, detail } = await readContainerStatus(containerId, config));
    } catch (error) {
      if (isPermanent(error)) {
        throw new PermanentError(describeError(error));
      }
      // A transient read failure should not abandon an otherwise healthy container; keep polling.
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
          (detail
            ? `Meta says: ${detail}`
            : 'Meta gave no reason. Usually the media failed its format checks, or PUBLIC_BASE_URL was unreachable.')
      );
    }

    logger.debug('Container still processing', { containerId, status });
  }

  throw new Error(`Container ${containerId} did not finish before the publish timeout`);
}

/**
 * A retry of media_publish cannot tell "Meta never got the request" from "Meta committed it
 * and the response was lost" (timeout, 5xx after commit) — and posting again in the second
 * case duplicates the story. Asking the container settles it: status_code flips to PUBLISHED
 * the moment the publish commits, independently of whether its response ever reached us.
 */
async function wasAlreadyPublished(
  containerId: string,
  config: InstagramPublishConfig,
  logger: Logger
): Promise<boolean> {
  try {
    const { status } = await readContainerStatus(containerId, config);
    if (status !== 'PUBLISHED') return false;

    logger.warn(
      'media_publish response was lost, but the container already shows PUBLISHED; treating ' +
        'the retry as unnecessary rather than risk posting the story twice',
      { containerId }
    );
    return true;
  } catch (error) {
    // Could not confirm either way; fall through and let the normal POST retry run its course.
    logger.debug('Could not confirm container status before retrying media_publish', {
      containerId,
      error: describeError(error),
    });
    return false;
  }
}

async function publishContainer(
  containerId: string,
  config: InstagramPublishConfig,
  timing: PublishTiming,
  logger: Logger
): Promise<string> {
  let attempt = 0;

  const response = await withRetry(
    async () => {
      attempt++;
      // The media id isn't available from the container, so the container id stands in for it.
      if (attempt > 1 && (await wasAlreadyPublished(containerId, config, logger))) {
        return { data: { id: containerId } };
      }

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

  // Meta diagnoses none of this usefully: an empty file is a bare 500, and an oversized one
  // sits in IN_PROGRESS before ending in ERROR with no reason — cheaper and clearer to check here.
  const refusal = rejectionReason({
    mediaType: media.mediaType,
    bytes: media.buffer.length,
    durationSeconds: media.durationSeconds,
  });
  if (refusal) {
    throw new PermanentError(`Story ${media.id} cannot be published: ${refusal}.`);
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
    // A live URL after publish is a leak of the media.
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
  // The live refresh endpoint is unversioned, unlike the publishing ones.
  const url = config.apiBase ? `${baseUrl(config)}/refresh_access_token` : REFRESH_URL;

  let response;
  try {
    response = await axios.get(url, {
      params: { grant_type: 'ig_refresh_token', access_token: config.accessToken },
      timeout: 15_000,
    });
  } catch (error) {
    throw new Error(`Token refresh rejected: ${describeError(error)}`, { cause: error });
  }

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error('Token refresh returned no access_token');
  }

  logger.info('Instagram access token refreshed', {
    expiresInDays: Math.round((response.data.expires_in ?? 0) / 86_400),
  });

  return { accessToken, expiresInSeconds: response.data.expires_in ?? 0 };
}

export interface PublishingLimit {
  used: number;
  total: number;
  remaining: number;
  /** Window the quota is measured over, in seconds. */
  durationSeconds: number;
}

/**
 * Meta's authoritative view of the rolling publish quota. Confirmed against
 * the live API: stories DO consume it, despite some docs implying otherwise.
 */
export async function getPublishingLimit(
  config: InstagramPublishConfig,
  logger: Logger
): Promise<PublishingLimit> {
  const response = await axios.get(
    `${baseUrl(config)}/${config.accountId}/content_publishing_limit`,
    {
      params: { fields: 'quota_usage,config' },
      headers: authHeaders(config),
      timeout: 15_000,
    }
  );

  const entry = response.data?.data?.[0];
  if (!entry) {
    throw new Error('content_publishing_limit returned no data');
  }

  const used = Number(entry.quota_usage ?? 0);
  const total = Number(entry.config?.quota_total ?? 100);

  logger.debug('Fetched publishing quota', { used, total });

  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    durationSeconds: Number(entry.config?.quota_duration ?? 86_400),
  };
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
