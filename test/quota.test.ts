import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaGuard, QuotaExceededError, DEFAULT_QUOTA_OPTIONS } from '../src/instagram/quota.js';
import { getPublishingLimit } from '../src/instagram/graph-api.js';
import type { InstagramPublishConfig } from '../src/instagram/types.js';
import { MetaStub, metaError } from './helpers/meta-stub.js';
import { silentLogger } from './helpers/logger.js';

/**
 * A fresh port per test: axios keeps sockets alive between requests, and
 * reusing one against a restarted stub surfaces as a random ECONNRESET in
 * whichever test happened to draw the stale socket.
 */
let nextPort = 45840;

describe('publish quota', () => {
  let meta: MetaStub;
  let config: InstagramPublishConfig;

  const guard = (overrides: Partial<typeof DEFAULT_QUOTA_OPTIONS> = {}) =>
    new QuotaGuard(() => config, { ...DEFAULT_QUOTA_OPTIONS, ...overrides }, silentLogger);

  beforeEach(async () => {
    meta = new MetaStub();
    await meta.start(nextPort++);
    config = { accountId: 'acct_1', accessToken: 'token_abc', apiBase: meta.url };
  });

  afterEach(async () => {
    await meta.stop();
  });

  describe('getPublishingLimit', () => {
    it('reads usage and total from Meta', async () => {
      meta.quotaUsage = 7;
      meta.quotaTotal = 100;

      const limit = await getPublishingLimit(config, silentLogger);

      assert.equal(limit.used, 7);
      assert.equal(limit.total, 100);
      assert.equal(limit.remaining, 93);
      assert.equal(limit.durationSeconds, 86_400);
    });

    it('never reports negative headroom', async () => {
      meta.quotaUsage = 120;
      meta.quotaTotal = 100;

      assert.equal((await getPublishingLimit(config, silentLogger)).remaining, 0);
    });
  });

  describe('ensureCapacity', () => {
    it('allows publishing with room to spare', async () => {
      meta.quotaUsage = 5;
      await assert.doesNotReject(() => guard().ensureCapacity());
    });

    it('blocks once the quota is spent', async () => {
      meta.quotaUsage = 100;

      await assert.rejects(
        () => guard().ensureCapacity(),
        (error: Error) => {
          assert.ok(error instanceof QuotaExceededError);
          assert.match(error.message, /100\/100/);
          return true;
        }
      );
    });

    it('honours a reserve held back for manual posting', async () => {
      meta.quotaUsage = 95;

      await assert.doesNotReject(() => guard({ reserve: 0 }).ensureCapacity());
      await assert.rejects(() => guard({ reserve: 10 }).ensureCapacity(), QuotaExceededError);
    });

    it('caches the reading instead of asking on every publish', async () => {
      const g = guard({ refreshIntervalMs: 60_000 });

      await g.ensureCapacity(1_000);
      await g.ensureCapacity(2_000);
      await g.ensureCapacity(3_000);

      assert.equal(meta.calls.length, 1, 'should have asked Meta once');
    });

    it('asks again once the cache goes stale', async () => {
      const g = guard({ refreshIntervalMs: 10_000 });

      await g.ensureCapacity(1_000);
      await g.ensureCapacity(20_000);

      assert.equal(meta.calls.length, 2);
    });

    // Publishing blind would burn a container and serve the media before Meta
    // refuses, so a guard that has never had a reading must refuse instead.
    it('refuses to publish when the quota has never been read', async () => {
      meta.quotaResponses = [metaError(500, 'Internal error', 1)];

      await assert.rejects(
        () => guard().ensureCapacity(),
        (error: Error) => {
          assert.ok(error instanceof QuotaExceededError);
          // A 0/0 message would misreport an unread quota as an exhausted one.
          assert.doesNotMatch(error.message, /0\/0/);
          return true;
        }
      );
    });

    it('keeps using a stale reading when a later refresh fails', async () => {
      const g = guard({ refreshIntervalMs: 10_000 });
      meta.quotaUsage = 3;
      await g.ensureCapacity(1_000);

      meta.quotaResponses = [metaError(503, 'Try later', 1)];
      await assert.doesNotReject(() => g.ensureCapacity(20_000));
      assert.equal(g.snapshot?.used, 3);
    });
  });

  describe('recordPublish', () => {
    it('counts locally so the cache stays accurate between refreshes', async () => {
      meta.quotaUsage = 98;
      const g = guard({ refreshIntervalMs: 60_000 });

      await g.ensureCapacity(1_000);
      g.recordPublish();
      assert.equal(g.snapshot?.used, 99);

      await assert.doesNotReject(() => g.ensureCapacity(2_000));

      g.recordPublish();
      assert.equal(g.snapshot?.used, 100);
      await assert.rejects(() => g.ensureCapacity(3_000), QuotaExceededError);
    });

    it("lets Meta's count overwrite the local one on refresh", async () => {
      const g = guard({ refreshIntervalMs: 10_000 });
      meta.quotaUsage = 10;
      await g.ensureCapacity(1_000);

      g.recordPublish();
      assert.equal(g.snapshot?.used, 11);

      // The rolling window moved on and Meta now reports fewer.
      meta.quotaUsage = 4;
      await g.ensureCapacity(20_000);
      assert.equal(g.snapshot?.used, 4);
    });

    it('does nothing when there is no reading to adjust', () => {
      const g = guard();
      g.recordPublish();
      assert.equal(g.snapshot, null);
    });
  });
});
