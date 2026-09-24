import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateStore, MAX_ATTEMPTS } from '../src/db/state.js';

/** A story stays visible for 24h and many polls see it; everything here guards "publish once". */
describe('StateStore', () => {
  let dir: string;
  let store: StateStore;

  const seen = (id: string) => store.attemptState(id, 'telegram', 'instagram') === 'done';
  const start = (id: string, user = '@someone') =>
    store.markProcessing(id, 'telegram', user, 'instagram');
  const posted = (id: string) => store.markPosted(id, 'telegram', 'instagram');
  const failed = (id: string, why = 'boom') => store.markFailed(id, 'telegram', 'instagram', why);
  const interrupted = (id: string, why = 'interrupted') =>
    store.markInterrupted(id, 'telegram', 'instagram', why);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'state-store-'));
    store = new StateStore(join(dir, 'state.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('deduplication', () => {
    it('does not know an unseen story', () => {
      assert.equal(seen('peer:1'), false);
    });

    it('blocks a story while it is being published', () => {
      start('peer:1');
      assert.equal(seen('peer:1'), true);
    });

    it('blocks a story once published', () => {
      start('peer:1');
      posted('peer:1');
      assert.equal(seen('peer:1'), true);
    });

    it('keeps blocking across reopens of the database', () => {
      start('peer:1');
      posted('peer:1');
      store.close();

      store = new StateStore(join(dir, 'state.db'));
      assert.equal(seen('peer:1'), true);
    });

    it('keeps peers apart, since story ids restart per peer', () => {
      start('111:3');
      posted('111:3');

      assert.equal(seen('222:3'), false, 'a different peer must not be shadowed');
    });

    it('tracks each target platform separately', () => {
      store.markProcessing('peer:1', 'telegram', '@x', 'instagram');
      store.markPosted('peer:1', 'telegram', 'instagram');

      assert.equal(store.attemptState('peer:1', 'telegram', 'telegram'), 'ready');
    });
  });

  describe('retrying failures', () => {
    // A transient rejection should come back around, not be written off.
    it('does not block a failed story', () => {
      start('peer:1');
      failed('peer:1');

      assert.equal(seen('peer:1'), false);
    });

    it('moves a failed story back to in-flight when retried', () => {
      start('peer:1');
      failed('peer:1');

      start('peer:1');
      assert.equal(seen('peer:1'), true, 'the retry must be protected too');
    });

    it('clears the old error once it finally succeeds', () => {
      start('peer:1');
      failed('peer:1', 'first attempt exploded');
      start('peer:1');
      posted('peer:1');

      assert.equal(seen('peer:1'), true);
      assert.equal(store.recoverStalled(), 0, 'nothing should still be in flight');
    });
  });

  // The cap stops a hopeless story being retried forever; the backoff keeps the cap from
  // writing off a whole day of stories during a brief outage.
  describe('retry cap', () => {
    const retry = () => store.attemptState('peer:1', 'telegram', 'instagram');

    /**
     * Rewinds the failure timestamp to fake the passage of time, over a second
     * connection so the store keeps no test-only surface of its own.
     */
    const failedMinutesAgo = (minutes: number, id = 'peer:1') => {
      const db = new DatabaseSync(join(dir, 'state.db'));
      db.exec(
        `UPDATE stories SET processed_at = datetime('now', '-${minutes} minutes')
         WHERE story_id = '${id}'`
      );
      db.close();
    };

    it('is ready to try a story it has never seen', () => {
      assert.equal(retry(), 'ready');
    });

    it('is ready again immediately after the first failure', () => {
      start('peer:1');
      failed('peer:1');

      assert.equal(retry(), 'ready', 'a first failure should come straight back');
    });

    it('holds off while the backoff has not elapsed', () => {
      start('peer:1');
      failed('peer:1');
      start('peer:1');
      failed('peer:1');

      assert.equal(retry(), 'waiting', 'the second failure buys a five minute wait');
    });

    it('is ready once the backoff has elapsed', () => {
      start('peer:1');
      failed('peer:1');
      start('peer:1');
      failed('peer:1');
      failedMinutesAgo(6);

      assert.equal(retry(), 'ready');
    });

    it('gives up after MAX_ATTEMPTS failures', () => {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        start('peer:1');
        failed('peer:1');
        failedMinutesAgo(500);
      }

      assert.equal(retry(), 'exhausted');
    });

    // Exactly MAX_ATTEMPTS, which is all the bridge will ever drive it to, and
    // then a week of waiting: the cap must not decay back into 'ready'.
    it('stays exhausted however long you wait', () => {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        start('peer:1');
        failed('peer:1');
        failedMinutesAgo(500);
      }
      assert.equal(retry(), 'exhausted');

      failedMinutesAgo(10_080);
      assert.equal(retry(), 'exhausted', 'time must not revive a written-off story');
    });

    // markProcessing runs before every attempt; resetting the counter there
    // would mean the cap never fires.
    it('does not forget past failures when the story is retried', () => {
      start('peer:1');
      failed('peer:1');
      start('peer:1');

      failedMinutesAgo(500);
      failed('peer:1');
      failedMinutesAgo(500);

      assert.equal(retry(), 'ready', 'two failures is not yet the cap');

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        start('peer:1');
        failed('peer:1');
        failedMinutesAgo(500);
      }
      assert.equal(retry(), 'exhausted');
    });

    // 'done' is no proof the counter was cleared, so this posts at the edge of exhaustion and
    // checks that one fresh failure lands at 'ready' rather than 'exhausted'.
    it('wipes the slate once a story finally publishes', () => {
      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
        start('peer:1');
        failed('peer:1');
      }
      start('peer:1');
      posted('peer:1');

      start('peer:1');
      failed('peer:1');
      assert.equal(retry(), 'ready', 'a success must not leave the counter armed');
    });

    it('counts each story separately', () => {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        start('peer:1');
        failed('peer:1');
        failedMinutesAgo(500);
      }

      assert.equal(retry(), 'exhausted');
      assert.equal(store.attemptState('peer:2', 'telegram', 'instagram'), 'ready');
    });

    // The production database predates the column.
    it('adds the attempts column to a database that lacks it', () => {
      store.close();

      const legacy = new DatabaseSync(join(dir, 'legacy.db'));
      legacy.exec(`
        CREATE TABLE stories (
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
      `);
      legacy
        .prepare(
          `INSERT INTO stories (story_id, platform, source_user, target_platform, status)
           VALUES ('peer:9', 'telegram', '@x', 'instagram', 'failed')`
        )
        .run();
      legacy.close();

      store = new StateStore(join(dir, 'legacy.db'));

      assert.equal(
        store.attemptState('peer:9', 'telegram', 'instagram'),
        'ready',
        'a row that predates the column starts from zero, not written off'
      );

      store.markFailed('peer:9', 'telegram', 'instagram', 'boom');
      assert.equal(store.attemptState('peer:9', 'telegram', 'instagram'), 'ready');
    });
  });

  describe('recoverStalled', () => {
    // 'processing' is set before an upload that can take a minute. A crash in
    // that window used to leave the row blocking attemptState() forever.
    it('frees a story left mid-publish by a crash', () => {
      start('peer:1');
      assert.equal(seen('peer:1'), true);

      assert.equal(store.recoverStalled(), 1);
      assert.equal(seen('peer:1'), false, 'it must be retried, not stuck');
    });

    it('leaves published stories alone', () => {
      start('peer:1');
      posted('peer:1');

      assert.equal(store.recoverStalled(), 0);
      assert.equal(seen('peer:1'), true);
    });

    it('reports nothing to recover on a clean start', () => {
      assert.equal(store.recoverStalled(), 0);
    });

    it('recovers several at once', () => {
      start('peer:1');
      start('peer:2');
      start('peer:3');
      posted('peer:2');

      assert.equal(store.recoverStalled(), 2);
    });
  });

  describe('markInterrupted', () => {
    const attemptsFor = (id: string): number => {
      const db = new DatabaseSync(join(dir, 'state.db'));
      const row = db.prepare('SELECT attempts FROM stories WHERE story_id = ?').get(id) as
        { attempts?: number } | undefined;
      db.close();
      return row?.attempts ?? 0;
    };

    // A publish cut short by stop() never reached Meta, so it must cost nothing — unlike a
    // real failure, which the 'retry cap' tests above show does spend an attempt.
    it('puts a never-failed story back to ready without spending an attempt', () => {
      start('peer:1');
      interrupted('peer:1');

      assert.equal(attemptsFor('peer:1'), 0, 'must not count as an attempt');
      assert.equal(
        store.attemptState('peer:1', 'telegram', 'instagram'),
        'ready',
        'an interrupted first try is no different from never having tried'
      );
    });

    it('preserves the backoff of an earlier real failure instead of resetting it', () => {
      start('peer:1');
      failed('peer:1');
      start('peer:1');
      failed('peer:1');
      assert.equal(
        store.attemptState('peer:1', 'telegram', 'instagram'),
        'waiting',
        'sanity check: two real failures buy a five minute wait'
      );

      start('peer:1');
      interrupted('peer:1', 'cut short by shutdown');

      assert.equal(attemptsFor('peer:1'), 2, 'must not add an attempt on top of the real ones');
      assert.equal(
        store.attemptState('peer:1', 'telegram', 'instagram'),
        'waiting',
        'the earlier failures still back off; being interrupted does not reset the clock'
      );
    });
  });

  describe('cleanup', () => {
    // created_at has one-second resolution, so "older than 0 days" only
    // becomes true once the clock has moved past the insert.
    const passASecond = () => new Promise((resolve) => setTimeout(resolve, 1_100));

    it('keeps recent records', () => {
      start('peer:1');
      posted('peer:1');

      assert.equal(store.cleanup(30), 0);
      assert.equal(seen('peer:1'), true);
    });

    it('never drops a story still in flight', async () => {
      start('peer:1');
      await passASecond();

      // Even with a zero-day window, an unfinished story must survive.
      assert.equal(store.cleanup(0), 0);
      assert.equal(seen('peer:1'), true);
    });

    it('drops finished records once past the window', async () => {
      start('peer:1');
      posted('peer:1');
      start('peer:2');
      failed('peer:2');
      await passASecond();

      assert.equal(store.cleanup(0), 2);
      assert.equal(seen('peer:1'), false);
    });
  });
});
