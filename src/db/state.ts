import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export type Platform = 'telegram' | 'instagram';

export type StoryStatus = 'processing' | 'posted' | 'failed';

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

/**
 * Remembers which stories have already been bridged.
 *
 * A story stays visible for 24h, so a two-minute poll sees the same one some
 * 700 times. Everything here exists to make sure it is published exactly once.
 */
export class StateStore {
  private readonly db: Database.Database;

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
        status TEXT NOT NULL DEFAULT 'processing',
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

  /**
   * True once a story is published or currently being published.
   *
   * 'failed' is deliberately absent: a transient rejection should be retried
   * on the next cycle rather than written off.
   */
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
    // Retrying a previously failed story has to move it back to 'processing';
    // INSERT OR IGNORE would leave it marked 'failed' for the whole attempt,
    // so isProcessed() would not protect it.
    this.db
      .prepare(
        `INSERT INTO stories (story_id, platform, source_user, target_platform, status)
         VALUES (?, ?, ?, ?, 'processing')
         ON CONFLICT(platform, story_id, target_platform)
         DO UPDATE SET status = 'processing', error_message = NULL`
      )
      .run(storyId, sourcePlatform, sourceUser, targetPlatform);
  }

  markPosted(storyId: string, sourcePlatform: Platform, targetPlatform: Platform): void {
    this.db
      .prepare(
        `UPDATE stories SET status = 'posted', processed_at = datetime('now'), error_message = NULL
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

  /**
   * Clears rows left mid-publish by a crash or a kill.
   *
   * 'processing' is set before the upload starts, and publishing a video can
   * take a minute. If the process dies in that window the row keeps blocking
   * isProcessed() forever, and that story is never retried. Only one process
   * owns this database, so nothing can legitimately be in flight at startup.
   *
   * Returns how many rows were recovered.
   */
  recoverStalled(): number {
    return this.db
      .prepare(
        `UPDATE stories SET status = 'failed', error_message = ?
         WHERE status = 'processing'`
      )
      .run('Interrupted before it finished; will be retried').changes;
  }

  /**
   * Drops rows that are past being useful. Story ids are never reused — they
   * expire after 24h — so old rows only cost space.
   */
  cleanup(daysOld: number = 30): number {
    return this.db
      .prepare(
        `DELETE FROM stories
         WHERE created_at < datetime('now', '-' || ? || ' days')
           AND status IN ('posted', 'failed')`
      )
      .run(daysOld).changes;
  }

  close(): void {
    this.db.close();
  }
}
