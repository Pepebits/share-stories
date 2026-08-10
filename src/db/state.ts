import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export type Platform = 'telegram' | 'instagram';

export type StoryStatus = 'new' | 'processing' | 'posted' | 'failed';

export interface StoredStory {
  id: number;
  platform: Platform;
  story_id: string;
  source_user: string;
  target_platform: Platform;
  status: StoryStatus;
  processed_at: string | null;
  created_at: string;
  error_message: string | null;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        story_id TEXT NOT NULL,
        source_user TEXT NOT NULL,
        target_platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        processed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        error_message TEXT,
        UNIQUE(platform, story_id, target_platform)
      );

      CREATE INDEX IF NOT EXISTS idx_stories_platform_id
        ON stories(platform, story_id, target_platform);

      CREATE INDEX IF NOT EXISTS idx_stories_status
        ON stories(status);
    `);
  }

  isProcessed(storyId: string, sourcePlatform: Platform, targetPlatform: Platform): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM stories
         WHERE story_id = ? AND platform = ? AND target_platform = ?
         AND status IN ('posted', 'processing')
         LIMIT 1`
      )
      .get(storyId, sourcePlatform, targetPlatform);
    return row !== undefined;
  }

  markProcessing(
    storyId: string,
    sourcePlatform: Platform,
    sourceUser: string,
    targetPlatform: Platform
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stories (story_id, platform, source_user, target_platform, status)
         VALUES (?, ?, ?, ?, 'processing')`
      )
      .run(storyId, sourcePlatform, sourceUser, targetPlatform);
  }

  markPosted(storyId: string, sourcePlatform: Platform, targetPlatform: Platform): void {
    this.db
      .prepare(
        `UPDATE stories SET status = 'posted', processed_at = datetime('now')
         WHERE story_id = ? AND platform = ? AND target_platform = ?`
      )
      .run(storyId, sourcePlatform, targetPlatform);
  }

  markFailed(
    storyId: string,
    sourcePlatform: Platform,
    targetPlatform: Platform,
    errorMessage: string
  ): void {
    this.db
      .prepare(
        `UPDATE stories SET status = 'failed', processed_at = datetime('now'), error_message = ?
         WHERE story_id = ? AND platform = ? AND target_platform = ?`
      )
      .run(errorMessage, storyId, sourcePlatform, targetPlatform);
  }

  getRecentStories(limit: number = 50): StoredStory[] {
    return this.db
      .prepare(`SELECT * FROM stories ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as StoredStory[];
  }

  getFailedStories(): StoredStory[] {
    return this.db
      .prepare(`SELECT * FROM stories WHERE status = 'failed' ORDER BY created_at DESC`)
      .all() as StoredStory[];
  }

  cleanup(daysOld: number = 30): number {
    const result = this.db
      .prepare(
        `DELETE FROM stories
         WHERE created_at < datetime('now', '-' || ? || ' days')
         AND status IN ('posted', 'failed')`
      )
      .run(daysOld);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
