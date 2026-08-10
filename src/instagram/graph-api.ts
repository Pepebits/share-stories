import axios from 'axios';
import { Logger } from '../utils/logger.js';
import { StoryMedia } from '../telegram/types.js';
import { GraphApiConfig } from './types.js';
import { withRetry } from '../utils/retry.js';

// Instagram Graph API base URL
const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';

export async function postStoryViaGraphApi(
  media: StoryMedia,
  config: GraphApiConfig,
  logger: Logger
): Promise<string> {
  if (!config.accessToken || !config.accountId) {
    throw new Error(
      'Graph API not configured. Set INSTAGRAM_GRAPH_ACCESS_TOKEN and INSTAGRAM_GRAPH_ACCOUNT_ID.'
    );
  }

  logger.info('Attempting to post story via Instagram Graph API', {
    sourceUser: media.sourceUser,
    mediaType: media.mediaType,
  });

  try {
    // Step 1: Create a media container
    // For Graph API, we need a publicly accessible URL for the media.
    // Since we have a Buffer, we'd need to upload somewhere first.
    // This is a limitation — Graph API doesn't accept direct uploads.
    //
    // For now, this method is documented as a placeholder that
    // explains the Graph API flow. Actual usage requires:
    // 1. Upload media to a public URL (S3, CDN, etc.)
    // 2. POST /{ig-user-id}/media with media_url
    // 3. POST /{ig-user-id}/media_publish with creation_id
    //
    throw new Error(
      'Graph API requires a publicly accessible media URL. ' +
      'Use the unofficial API (instagram-private-api) as the primary method.'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Graph API story upload failed, will fall back', { error: message });
    throw error;
  }
}

/**
 * Refresh the long-lived access token.
 * Long-lived tokens expire after 60 days.
 * Call this periodically (e.g., every 30 days).
 */
export async function refreshAccessToken(
  config: GraphApiConfig,
  logger: Logger
): Promise<string> {
  if (!config.accessToken || !config.appId || !config.appSecret) {
    throw new Error('Missing Graph API credentials for token refresh');
  }

  try {
    const response = await withRetry(
      async () => {
        const res = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: config.appId,
            client_secret: config.appSecret,
            fb_exchange_token: config.accessToken,
          },
        });
        return res.data;
      },
      {
        maxRetries: 2,
        baseDelayMs: 2000,
        maxDelayMs: 5000,
        logger,
        operation: 'instagram-token-refresh',
      }
    );

    logger.info('Instagram Graph API token refreshed');
    return response.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to refresh Instagram Graph API token', { error: message });
    throw error;
  }
}

/**
 * Validate that the Graph API credentials are configured.
 */
export function isGraphApiConfigured(config: GraphApiConfig): boolean {
  return !!(config.accessToken && config.accountId);
}

/**
 * Get basic info about the Instagram Business account.
 */
export async function getAccountInfo(
  config: GraphApiConfig,
  logger: Logger
): Promise<Record<string, unknown> | null> {
  if (!isGraphApiConfigured(config)) return null;

  try {
    const response = await axios.get(
      `${GRAPH_API_BASE}/${config.accountId}`,
      {
        params: {
          fields: 'id,username,name,profile_picture_url',
          access_token: config.accessToken,
        },
      }
    );
    return response.data;
  } catch (error) {
    logger.warn('Failed to get Instagram account info from Graph API', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
