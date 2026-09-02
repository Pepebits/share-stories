import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Platform = 'telegram' | 'instagram';

export type StoryStatus = 'processing' | 'posted' | 'failed';

/** Whether a previously failed story is due for another try. */
export type RetryState = 'ready' | 'waiting' | 'exhausted';

/**
 * Minutes to wait after the Nth failure before trying again — the first entry
 * applies after one failure, so a single blip comes straight back around.
 *
 * A flat cap is a trap at a two-minute poll: five straight attempts would be
 * spent in ten minutes, so an outage affecting every story — an expired token,
 * an unreachable media server — would write off a whole day of stories before
 * anyone could react. Stretched this way the fifth attempt lands about two
 * hours after the first, which still kills the retry storm but survives
 * something transient.
 */
const RETRY_BACKOFF_MINUTES = [0, 5, 20, 90];

/** Failures after which a story is written off until it expires. */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;

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
  attempts: number;
}

/**
 * Remembers which stories have already been bridged.
 *
 * A story stays visible for 24h, so a two-minute poll sees the same one some
 * 700 times. Everything here exists to make sure it is published exactly once.
 *
 * Uses Node's built-in SQLite rather than a native module: better-sqlite3 has
 * to be compiled whenever no prebuild matches the running ABI, which turns
 * every Node upgrade into a build problem.
 */
export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
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
        attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(platform, story_id, target_platform)
      );

      CREATE INDEX IF NOT EXISTS idx_stories_platform_id
        ON stories(platform, story_id, target_platform);

      CREATE INDEX IF NOT EXISTS idx_stories_status
        ON stories(status);
    `);

    // CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so a
    // database created before the retry cap needs the column added by hand.
    const columns = this.db.prepare('PRAGMA table_info(stories)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'attempts')) {
      this.db.exec('ALTER TABLE stories ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * Whether a failed story is due for another attempt.
   *
   * 'ready' for anything not currently in a failed state, so an unseen story
   * is always worth trying. Retrying regardless of this is what turned ten
   * stories into 1,563 failed publishes and some 4,700 requests to Meta.
   */
  retryState(
    storyId: string,
    sourcePlatform: Platform,
    targetPlatform: Platform
  ): RetryState {
    const row = this.db
      .prepare(
        `SELECT attempts, processed_at FROM stories
         WHERE story_id = ? AND platform = ? AND target_platform = ?
           AND status = 'failed'
         LIMIT 1`
      )
      .get(storyId, sourcePlatform, targetPlatform) as
      | { attempts?: number; processed_at?: string | null }
      | undefined;

    if (!row) return 'ready';

    const attempts = Number(row.attempts ?? 0);
    if (attempts >= MAX_ATTEMPTS) return 'exhausted';

    const waitMinutes = RETRY_BACKOFF_MINUTES[attempts - 1] ?? 0;
    if (waitMinutes === 0 || !row.processed_at) return 'ready';

    // SQLite writes datetime('now') as UTC without a zone marker, which
    // Date.parse would otherwise read as local time.
    const failedAt = Date.parse(`${row.processed_at.replace(' ', 'T')}Z`);
    if (Number.isNaN(failedAt)) return 'ready';

    return Date.now() >= failedAt + waitMinutes * 60_000 ? 'ready' : 'waiting';
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
        `UPDATE stories SET status = 'posted', processed_at = datetime('now'),
                error_message = NULL, attempts = 0
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
        // attempts drives the backoff, so it accumulates across cycles; only a
        // successful publish clears it.
        `UPDATE stories SET status = 'failed', processed_at = datetime('now'),
                error_message = ?, attempts = attempts + 1
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
      .run('Interrupted before it finished; will be retried').changes as number;
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
      .run(daysOld).changes as number;
  }

  close(): void {
    this.db.close();
  }
}
