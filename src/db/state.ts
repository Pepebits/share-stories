import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Platform = 'telegram' | 'instagram';

export type StoryStatus = 'processing' | 'posted' | 'failed';

/** 'ready' covers both an unseen story and a failure whose backoff has elapsed. */
export type AttemptState = 'ready' | 'done' | 'waiting' | 'exhausted';

/**
 * Minutes to wait after the Nth failure before trying again. A flat cap would
 * burn through every attempt within minutes at a two-minute poll, writing off
 * a whole day of stories during an outage; stretching it out survives that.
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
 * Remembers which stories have already been bridged, so a story that stays
 * visible for 24h and gets polled repeatedly is published exactly once.
 *
 * Uses Node's built-in SQLite rather than a native module: better-sqlite3
 * needs compiling whenever no prebuild matches the running ABI, turning every
 * Node upgrade into a build problem.
 */
export class StateStore {
  private readonly db: DatabaseSync;

  // Prepared once and reused: re-preparing on every call recompiles the same SQL every time,
  // for statements that run on every story, every poll cycle.
  private readonly attemptStateStmt: StatementSync;
  private readonly markProcessingStmt: StatementSync;
  private readonly markPostedStmt: StatementSync;
  private readonly markFailedStmt: StatementSync;
  private readonly markInterruptedStmt: StatementSync;
  private readonly recoverStalledStmt: StatementSync;
  private readonly cleanupStmt: StatementSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.init();

    this.attemptStateStmt = this.db.prepare(
      `SELECT status, attempts, processed_at FROM stories
       WHERE story_id = ? AND platform = ? AND target_platform = ?
       LIMIT 1`
    );
    this.markProcessingStmt = this.db.prepare(
      `INSERT INTO stories (story_id, platform, source_user, target_platform, status)
       VALUES (?, ?, ?, ?, 'processing')
       ON CONFLICT(platform, story_id, target_platform)
       DO UPDATE SET status = 'processing', error_message = NULL`
    );
    this.markPostedStmt = this.db.prepare(
      `UPDATE stories SET status = 'posted', processed_at = datetime('now'),
              error_message = NULL, attempts = 0
       WHERE story_id = ? AND platform = ? AND target_platform = ?`
    );
    this.markFailedStmt = this.db.prepare(
      // attempts drives the backoff, so it accumulates across cycles; only a
      // successful publish clears it.
      `UPDATE stories SET status = 'failed', processed_at = datetime('now'),
              error_message = ?, attempts = attempts + 1
       WHERE story_id = ? AND platform = ? AND target_platform = ?`
    );
    this.markInterruptedStmt = this.db.prepare(
      // Deliberately leaves attempts and processed_at untouched — see markInterrupted().
      `UPDATE stories SET status = 'failed', error_message = ?
       WHERE story_id = ? AND platform = ? AND target_platform = ?`
    );
    this.recoverStalledStmt = this.db.prepare(
      `UPDATE stories SET status = 'failed', error_message = ?
       WHERE status = 'processing'`
    );
    this.cleanupStmt = this.db.prepare(
      `DELETE FROM stories
       WHERE created_at < datetime('now', '-' || ? || ' days')
         AND status IN ('posted', 'failed')`
    );
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

      CREATE INDEX IF NOT EXISTS idx_stories_status
        ON stories(status);

      -- SQLite already maintains an index backing the UNIQUE constraint above; this one only
      -- ever duplicated it. Dropped for databases created before this stopped being created.
      DROP INDEX IF EXISTS idx_stories_platform_id;
    `);

    // CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so a database from
    // before the retry cap needs this column added by hand.
    const columns = this.db.prepare('PRAGMA table_info(stories)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'attempts')) {
      this.db.exec('ALTER TABLE stories ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * Whether a story is worth spending an attempt on right now. No row means
   * 'ready'; 'posted' or 'processing' is 'done'. A 'failed' row applies the
   * backoff — retrying regardless of it is what once turned a handful of
   * stories into a flood of failed publishes against Meta.
   */
  attemptState(storyId: string, sourcePlatform: Platform, targetPlatform: Platform): AttemptState {
    const row = this.attemptStateStmt.get(storyId, sourcePlatform, targetPlatform) as
      { status: StoryStatus; attempts?: number; processed_at?: string | null } | undefined;

    if (!row) return 'ready';
    if (row.status === 'posted' || row.status === 'processing') return 'done';

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

  markProcessing(
    storyId: string,
    sourcePlatform: Platform,
    sourceUser: string,
    targetPlatform: Platform
  ): void {
    // Must move a retried story back to 'processing'; INSERT OR IGNORE would leave it
    // 'failed' for the whole attempt, so attemptState() would not protect it.
    this.markProcessingStmt.run(storyId, sourcePlatform, sourceUser, targetPlatform);
  }

  markPosted(storyId: string, sourcePlatform: Platform, targetPlatform: Platform): void {
    this.markPostedStmt.run(storyId, sourcePlatform, targetPlatform);
  }

  markFailed(
    storyId: string,
    sourcePlatform: Platform,
    targetPlatform: Platform,
    errorMessage: string
  ): void {
    this.markFailedStmt.run(errorMessage, storyId, sourcePlatform, targetPlatform);
  }

  /**
   * Sends one story back to 'failed' after a publish was cut short by shutdown before it could
   * commit anything — as opposed to a real failure, this must cost nothing, so unlike
   * markFailed() it leaves attempts and processed_at untouched: attempts keeps the backoff of
   * any earlier real failure rather than restarting it, and a story with none yet stays
   * attemptState() === 'ready' since attempts is still 0. Same shape as recoverStalled(),
   * scoped to the one story stop() interrupted instead of every row left mid-publish at boot.
   */
  markInterrupted(
    storyId: string,
    sourcePlatform: Platform,
    targetPlatform: Platform,
    errorMessage: string
  ): void {
    this.markInterruptedStmt.run(errorMessage, storyId, sourcePlatform, targetPlatform);
  }

  /**
   * Clears rows left mid-publish by a crash or kill. 'processing' is set
   * before the upload starts, so a process dying in that window would block
   * attemptState() on that story forever; only one process owns this database.
   */
  recoverStalled(): number {
    return this.recoverStalledStmt.run('Interrupted before it finished; will be retried')
      .changes as number;
  }

  /**
   * Drops rows that are past being useful. Story ids are never reused — they
   * expire after 24h — so old rows only cost space.
   */
  cleanup(daysOld: number = 30): number {
    return this.cleanupStmt.run(daysOld).changes as number;
  }

  close(): void {
    this.db.close();
  }
}
