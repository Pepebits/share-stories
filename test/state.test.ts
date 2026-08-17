import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/db/state.js';

/**
 * A story stays visible for 24h, so a two-minute poll sees the same one some
 * 700 times. Everything here guards the "publish exactly once" property.
 */
describe('StateStore', () => {
  let dir: string;
  let store: StateStore;

  const seen = (id: string) => store.isProcessed(id, 'telegram', 'instagram');
  const start = (id: string, user = '@someone') =>
    store.markProcessing(id, 'telegram', user, 'instagram');
  const posted = (id: string) => store.markPosted(id, 'telegram', 'instagram');
  const failed = (id: string, why = 'boom') => store.markFailed(id, 'telegram', 'instagram', why);

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

      assert.equal(store.isProcessed('peer:1', 'telegram', 'telegram'), false);
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

  describe('recoverStalled', () => {
    // 'processing' is set before an upload that can take a minute. A crash in
    // that window used to leave the row blocking isProcessed() forever.
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
