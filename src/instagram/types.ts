export interface InstagramStoryItem {
  pk: string;
  id: string;
  taken_at: number;
  media_type: number; // 1 = photo, 2 = video
  image_versions2?: {
    candidates: Array<{ url: string; width: number; height: number }>;
  };
  video_versions?: Array<{ url: string; width: number; height: number }>;
  caption?: {
    text: string;
  };
  user: {
    pk: number;
    username: string;
    full_name?: string;
  };
}

export interface InstagramStoryResponse {
  reel: {
    id: string;
    user: {
      pk: number;
      username: string;
    };
    items: InstagramStoryItem[];
  } | null;
}

export interface GraphApiConfig {
  appId: string;
  appSecret: string;
  accountId: string;
  accessToken: string;
}
