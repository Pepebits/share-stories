export interface StoryMedia {
  id: string;
  sourceUser: string;
  sourcePlatform: 'telegram' | 'instagram';
  mediaType: 'photo' | 'video';
  buffer: Buffer;
  caption?: string;
  timestamp: number;
  duration?: number;
  width?: number;
  height?: number;
}

export interface TelegramPeer {
  username: string;
  accessHash?: string;
}

export interface InstagramUser {
  username: string;
  pk?: string | number;
}

export interface BridgeResult {
  success: boolean;
  storyId: string;
  sourcePlatform: 'telegram' | 'instagram';
  targetPlatform: 'telegram' | 'instagram';
  targetStoryId?: string;
  error?: string;
}
