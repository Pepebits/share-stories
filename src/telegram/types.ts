/** A story downloaded from the source, ready to be published. */
export interface StoryMedia {
  /** Unique across peers: story ids restart per peer. */
  id: string;
  sourceUser: string;
  sourcePlatform: 'telegram' | 'instagram';
  mediaType: 'photo' | 'video';
  buffer: Buffer;
  /** From Telegram's own metadata, so it is known before the download. */
  durationSeconds?: number;
  caption?: string;
  /** Epoch milliseconds. */
  timestamp: number;
}
