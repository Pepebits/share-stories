/** A story downloaded from the source, ready to be published. */
export interface StoryMedia {
  /** Unique across peers: story ids restart per peer. */
  id: string;
  sourceUser: string;
  mediaType: 'photo' | 'video';
  buffer: Buffer;
  /** From Telegram's own metadata, so it is known before the download. */
  durationSeconds?: number;
  caption?: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** What the bridge needs from a story source, independent of GramJS. */
export interface StorySource {
  /** Yields each story as soon as it is downloaded, so the bridge can publish while more arrive. */
  stories(peers: string[], isWanted: (storyId: string) => boolean): AsyncIterable<StoryMedia>;
  notifySelf(text: string): Promise<void>;
  isConnected(): boolean;
  reconnect(): Promise<void>;
}
