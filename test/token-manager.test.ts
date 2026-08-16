import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenManager, type StoredToken } from '../src/instagram/token-manager.js';
import { MetaStub, metaError } from './helpers/meta-stub.js';
import { silentLogger } from './helpers/logger.js';

// Fresh port per test — see quota.test.ts for why.
let nextPort = 45870;
const DAY_MS = 86_400_000;

describe('TokenManager', () => {
  let meta: MetaStub;
  let dir: string;
  let tokenFile: string;

  const makeManager = (envToken = 'env_token', overrides = {}) =>
    new TokenManager(
      {
        filePath: tokenFile,
        envToken,
        accountId: 'acct_1',
        apiBase: meta.url,
        refreshWhenRemainingMs: 14 * DAY_MS,
        checkIntervalMs: 60_000,
        ...overrides,
      },
      silentLogger
    );

  const readStored = async (): Promise<StoredToken> =>
    JSON.parse(await readFile(tokenFile, 'utf8')) as StoredToken;

  beforeEach(async () => {
    meta = new MetaStub();
    await meta.start(nextPort++);
    dir = await mkdtemp(join(tmpdir(), 'token-manager-'));
    tokenFile = join(dir, 'instagram-token.json');
  });

  afterEach(async () => {
    await meta.stop();
    await rm(dir, { recursive: true, force: true });
  });

  describe('loading', () => {
    it('seeds from .env when no file exists', async () => {
      const manager = makeManager('env_token');
      await manager.load();

      assert.equal(manager.config().accessToken, 'env_token');
      assert.equal(manager.state.expiresAt, null);
    });

    it('prefers the stored token over .env', async () => {
      const stored: StoredToken = {
        accessToken: 'stored_token',
        expiresAt: Date.now() + 50 * DAY_MS,
        refreshedAt: Date.now(),
        seededFrom: 'env_token',
      };
      await writeFile(tokenFile, JSON.stringify(stored));

      const manager = makeManager('env_token');
      await manager.load();

      assert.equal(manager.config().accessToken, 'stored_token');
    });

    // Otherwise a manually re-issued token would be ignored in favour of an
    // expired chain, and the operator would have no way to recover.
    it('abandons the stored chain when .env holds a different token', async () => {
      const stored: StoredToken = {
        accessToken: 'stale_token',
        expiresAt: Date.now() + 50 * DAY_MS,
        refreshedAt: Date.now(),
        seededFrom: 'old_env_token',
      };
      await writeFile(tokenFile, JSON.stringify(stored));

      const manager = makeManager('brand_new_env_token');
      await manager.load();

      assert.equal(manager.config().accessToken, 'brand_new_env_token');
      assert.equal(manager.state.expiresAt, null);
    });

    it('falls back to .env when the file is corrupt', async () => {
      await writeFile(tokenFile, '{ this is not json');

      const manager = makeManager('env_token');
      await manager.load();

      assert.equal(manager.config().accessToken, 'env_token');
    });
  });

  describe('refreshing', () => {
    it('refreshes when expiry is unknown', async () => {
      const manager = makeManager();
      await manager.load();

      assert.equal(await manager.refreshIfNeeded(), true);
      assert.equal(manager.config().accessToken, 'refreshed_1');
      assert.ok(manager.state.expiresAt);
    });

    it('does nothing while the token has plenty of life left', async () => {
      const stored: StoredToken = {
        accessToken: 'healthy_token',
        expiresAt: Date.now() + 55 * DAY_MS,
        refreshedAt: Date.now(),
        seededFrom: 'env_token',
      };
      await writeFile(tokenFile, JSON.stringify(stored));

      const manager = makeManager();
      await manager.load();

      assert.equal(await manager.refreshIfNeeded(), false);
      assert.equal(manager.config().accessToken, 'healthy_token');
      assert.equal(meta.calls.length, 0, 'must not call Meta');
    });

    it('refreshes once inside the renewal window', async () => {
      const stored: StoredToken = {
        accessToken: 'expiring_token',
        expiresAt: Date.now() + 3 * DAY_MS,
        refreshedAt: Date.now(),
        seededFrom: 'env_token',
      };
      await writeFile(tokenFile, JSON.stringify(stored));

      const manager = makeManager();
      await manager.load();

      assert.equal(await manager.refreshIfNeeded(), true);
      assert.equal(manager.config().accessToken, 'refreshed_1');
    });

    it('records the new expiry from expires_in', async () => {
      const manager = makeManager();
      await manager.load();

      const now = Date.now();
      await manager.refreshIfNeeded(now);

      // The stub reports 60 days.
      const days = Math.round(((manager.state.expiresAt ?? 0) - now) / DAY_MS);
      assert.equal(days, 60);
    });

    // Meta rejects a refresh for tokens younger than 24 hours. That is the
    // normal answer right after issuing one, not a reason to fall over.
    it('survives a rejected refresh and keeps the current token', async () => {
      meta.refreshResponses = [metaError(400, 'Token must be at least 24 hours old', 190)];

      const manager = makeManager('env_token');
      await manager.load();

      assert.equal(await manager.refreshIfNeeded(), false);
      assert.equal(manager.config().accessToken, 'env_token');
    });

    it('retries on the next cycle after a rejection', async () => {
      meta.refreshResponses = [metaError(400, 'Token must be at least 24 hours old', 190)];

      const manager = makeManager('env_token');
      await manager.load();

      assert.equal(await manager.refreshIfNeeded(), false);
      assert.equal(await manager.refreshIfNeeded(), true);
      assert.equal(manager.config().accessToken, 'refreshed_1');
    });
  });

  describe('persistence', () => {
    it('writes the refreshed token to disk', async () => {
      const manager = makeManager();
      await manager.load();
      await manager.refreshIfNeeded();

      const stored = await readStored();
      assert.equal(stored.accessToken, 'refreshed_1');
      assert.equal(stored.seededFrom, 'env_token');
      assert.ok(stored.expiresAt && stored.refreshedAt);
    });

    it('writes the token file owner-readable only', async () => {
      const manager = makeManager();
      await manager.load();
      await manager.refreshIfNeeded();

      const mode = (await stat(tokenFile)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    });

    it('leaves no temp file behind', async () => {
      const manager = makeManager();
      await manager.load();
      await manager.refreshIfNeeded();

      await assert.rejects(() => stat(`${tokenFile}.tmp`));
    });

    it('survives a restart without touching Meta again', async () => {
      const first = makeManager();
      await first.load();
      await first.refreshIfNeeded();
      const callsAfterFirst = meta.calls.length;

      const second = makeManager();
      await second.load();

      assert.equal(second.config().accessToken, 'refreshed_1');
      assert.equal(await second.refreshIfNeeded(), false);
      assert.equal(meta.calls.length, callsAfterFirst, 'restart must not re-refresh');
    });

    it('keeps serving the token when the file cannot be written', async () => {
      const manager = makeManager('env_token', {
        filePath: join(dir, 'no-such-dir/\0bad/token.json'),
      });
      await manager.load();

      // Persisting fails, but the in-memory token is still the fresh one.
      assert.equal(await manager.refreshIfNeeded(), true);
      assert.equal(manager.config().accessToken, 'refreshed_1');
    });
  });

  describe('config()', () => {
    it('reflects the rotated token, not the one captured at startup', async () => {
      const manager = makeManager();
      await manager.load();

      const before = manager.config();
      await manager.refreshIfNeeded();
      const after = manager.config();

      assert.equal(before.accessToken, 'env_token');
      assert.equal(after.accessToken, 'refreshed_1');
    });
  });
});
