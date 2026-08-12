/**
 * Credentials for the official Content Publishing API
 * ("Instagram API with Instagram Login").
 */
export interface InstagramPublishConfig {
  /** Numeric Instagram professional account id. */
  accountId: string;
  /** Long-lived token; expires after 60 days. */
  accessToken: string;
}
