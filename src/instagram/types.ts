/**
 * Credentials for the official Content Publishing API
 * ("Instagram API with Instagram Login").
 */
export interface InstagramPublishConfig {
  /** Numeric Instagram professional account id. */
  accountId: string;
  /** Long-lived token; expires after 60 days. */
  accessToken: string;
  /**
   * API origin including version. Defaults to the live Graph endpoint;
   * override to pin a different version or to point tests at a stub.
   */
  apiBase?: string;
}

/**
 * Polling and retry schedule for a publish. Extracted so tests can collapse
 * the multi-minute production schedule into milliseconds.
 */
export interface PublishTiming {
  /** Waits between container status checks; the last value repeats. */
  pollDelaysMs: number[];
  pollTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}
