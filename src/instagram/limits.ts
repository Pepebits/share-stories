/**
 * What Instagram will accept as a story. Meta does not reject an oversized story up front —
 * it ends the container in ERROR minutes later with no reason attached. Checking here turns
 * that into a log line, and lets the reader skip the download entirely.
 */

/** Stories cut off at 60 seconds; Telegram's own limit is the same. */
export const MAX_VIDEO_SECONDS = 60;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export interface MediaFacts {
  mediaType: 'photo' | 'video';
  bytes?: number;
  durationSeconds?: number;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Why Instagram would refuse this story, or null if nothing is wrong. Every field is optional
 * since the reader only has Telegram's metadata while the publisher has the bytes in hand.
 */
export function rejectionReason(facts: MediaFacts): string | null {
  const { mediaType, bytes, durationSeconds } = facts;

  if (bytes !== undefined && bytes === 0) {
    return 'the media is empty';
  }

  if (mediaType === 'video') {
    if (durationSeconds !== undefined && durationSeconds > MAX_VIDEO_SECONDS) {
      return `the video runs ${durationSeconds.toFixed(1)}s, over Instagram's ${MAX_VIDEO_SECONDS}s limit for stories`;
    }
    if (bytes !== undefined && bytes > MAX_VIDEO_BYTES) {
      return `the video is ${mb(bytes)}, over Instagram's ${mb(MAX_VIDEO_BYTES)} limit`;
    }
    return null;
  }

  if (bytes !== undefined && bytes > MAX_PHOTO_BYTES) {
    return `the photo is ${mb(bytes)}, over Instagram's ${mb(MAX_PHOTO_BYTES)} limit`;
  }

  return null;
}
