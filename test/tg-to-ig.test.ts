import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTgToIgBridge, MAX_RECONNECT_FAILURES } from '../src/bridge/tg-to-ig.js';
import { StateStore, MAX_ATTEMPTS } from '../src/db/state.js';
import { QuotaExceededError } from '../src/instagram/quota.js';
import type { StorySource, StoryMedia } from '../src/telegram/types.js';
import { MediaServer } from '../src/http/media-server.js';
import { silentLogger } from './helpers/logger.js';
import { MetaStub } from './helpers/meta-stub.js';

// Below the ephemeral range, distinct from graph-api.test.ts's port. See MetaStub.start.
const MEDIA_PORT = 25812;

/**
 * The reader downloads everything it yields, so what the bridge asks it for is the whole
 * cost control — the gate below is what keeps a hopeless story from being retried forever.
 */
describe('createTgToIgBridge', () => {
  let dir: string;
  let store: StateStore;

  const story = (id: string): StoryMedia => ({
    id,
    sourceUser: '@someone',
    mediaType: 'photo',
    buffer: Buffer.from('bytes'),
    timestamp: 1_700_000_000,
  });

  /** Records the predicate the bridge hands the reader, and what it allowed. */
  const stubReader = (available: string[], overrides: Partial<StorySource> = {}) => {
    const asked: string[][] = [];
    const alerts: string[] = [];

    const reader: StorySource = {
      stories: async function* (_peers, isWanted = () => true) {
        await Promise.resolve();
        const allowed = available.filter((id) => isWanted(id));
        asked.push(allowed);
        for (const id of allowed) yield story(id);
      },
      notifySelf: (text) => {
        alerts.push(text);
        return Promise.resolve();
      },
      isConnected: () => true,
      reconnect: async () => {},
      ...overrides,
    };

    return { reader, asked, alerts };
  };

  const neverPublishes = {
    host: () => ({ url: 'http://example.invalid/x.jpg', release: () => {} }),
  } as unknown as MediaServer;

  const bridgeOver = (
    reader: StorySource,
    alertAfterFailures = 0,
    onFatal: (reason: string) => void = () => {}
  ) =>
    createTgToIgBridge(
      reader,
      neverPublishes,
      store,
      {
        pollIntervalMs: 60_000,
        monitoredPeers: ['@someone'],
        alertAfterFailures,
        // Publishing is not configured, so every attempt fails permanently —
        // which is exactly what exercises the retry accounting.
        instagram: () => ({ accountId: '', accessToken: '' }),
        quota: {
          ensureCapacity: async () => {},
          recordPublish: () => {},
        } as never,
        onFatal,
      },
      silentLogger
    );

  /** Runs exactly one poll cycle. */
  const pollOnce = async (bridge: ReturnType<typeof bridgeOver>) => {
    bridge.start();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.stop();
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bridge-'));
    store = new StateStore(join(dir, 'state.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('asks the reader for a story it has never seen', async () => {
    const { reader, asked } = stubReader(['peer:1']);

    await pollOnce(bridgeOver(reader));

    assert.deepEqual(asked[0], ['peer:1']);
  });

  // The reader spends bandwidth on whatever passes this predicate, so a story
  // that is already published must never get that far.
  it('does not ask the reader for an already published story', async () => {
    store.markProcessing('peer:1', 'telegram', '@someone', 'instagram');
    store.markPosted('peer:1', 'telegram', 'instagram');

    const { reader, asked } = stubReader(['peer:1', 'peer:2']);
    await pollOnce(bridgeOver(reader));

    assert.deepEqual(asked[0], ['peer:2'], 'the published story must not be fetched again');
  });

  it('does not ask the reader for a story waiting out its backoff', async () => {
    // Two failures buys a five minute wait.
    store.markProcessing('peer:1', 'telegram', '@someone', 'instagram');
    store.markFailed('peer:1', 'telegram', 'instagram', 'boom');
    store.markProcessing('peer:1', 'telegram', '@someone', 'instagram');
    store.markFailed('peer:1', 'telegram', 'instagram', 'boom');

    const { reader, asked } = stubReader(['peer:1']);
    await pollOnce(bridgeOver(reader));

    assert.deepEqual(asked[0], [], 'a cooling-down story costs nothing');
  });

  it('stops asking once a story has burned every attempt', async () => {
    const { reader, asked } = stubReader(['peer:1']);
    const bridge = bridgeOver(reader);

    // Each cycle fails permanently; rewind the clock so the backoff never
    // shields the story and every cycle spends one attempt.
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await pollOnce(bridge);
      await rewindBackoff();
    }

    assert.equal(
      store.attemptState('peer:1', 'telegram', 'instagram'),
      'exhausted',
      'the story should be written off'
    );
    assert.deepEqual(asked.at(-1), [], 'and never fetched again');
    assert.ok(
      asked.filter((batch) => batch.length > 0).length <= MAX_ATTEMPTS,
      `at most ${MAX_ATTEMPTS} cycles should have fetched it`
    );
  });

  // The point of the alert: a failure only the log records goes unnoticed for days.
  describe('alerting', () => {
    it('says nothing until the threshold is reached', async () => {
      const { reader, alerts } = stubReader(['peer:1', 'peer:2']);

      await pollOnce(bridgeOver(reader, 3));

      assert.equal(alerts.length, 0, 'two failures is below the threshold');
    });

    it('sends one message once enough publishes fail in a row', async () => {
      const { reader, alerts } = stubReader(['peer:1', 'peer:2', 'peer:3', 'peer:4']);

      await pollOnce(bridgeOver(reader, 3));

      assert.equal(alerts.length, 1, 'exactly one message, not one per failure');
      assert.match(alerts[0], /failed to publish/);
    });

    // An alert per failure during an outage is noise, and noise stops being read.
    it('does not repeat itself while the failures continue', async () => {
      const { reader, alerts } = stubReader(['peer:1', 'peer:2', 'peer:3', 'peer:4']);
      const bridge = bridgeOver(reader, 3);

      await pollOnce(bridge);
      await rewindBackoff();
      await pollOnce(bridge);

      assert.equal(alerts.length, 1, 'still just the one');
    });

    it('stays quiet when the alert is switched off', async () => {
      const { reader, alerts } = stubReader(['peer:1', 'peer:2', 'peer:3', 'peer:4']);

      await pollOnce(bridgeOver(reader, 0));

      assert.equal(alerts.length, 0);
    });
  });

  describe('reconnection', () => {
    it('fetches stories once a lost connection reconnects', async () => {
      const { reader, asked } = stubReader(['peer:1'], {
        isConnected: () => false,
        reconnect: async () => {},
      });

      await pollOnce(bridgeOver(reader));

      assert.deepEqual(asked[0], ['peer:1']);
    });

    it('does not fetch stories when reconnecting fails', async () => {
      const { reader, asked } = stubReader(['peer:1'], {
        isConnected: () => false,
        reconnect: () => Promise.reject(new Error('offline')),
      });

      await pollOnce(bridgeOver(reader));

      assert.deepEqual(asked, [], 'a failed reconnect must not cost a fetch');
    });

    it('calls onFatal once reconnecting has failed enough times in a row', async () => {
      const { reader } = stubReader(['peer:1'], {
        isConnected: () => false,
        reconnect: () => Promise.reject(new Error('offline')),
      });
      const fatal: string[] = [];
      const bridge = bridgeOver(reader, 0, (reason) => fatal.push(reason));

      for (let i = 0; i < MAX_RECONNECT_FAILURES - 1; i++) {
        await pollOnce(bridge);
      }
      assert.equal(fatal.length, 0, 'not yet at the threshold');

      await pollOnce(bridge);
      assert.equal(fatal.length, 1, 'called exactly once at the threshold');
    });
  });

  describe('quota', () => {
    // Regression: ensureCapacity was only checked inside the for-await, i.e. after the reader
    // had already downloaded the next story — so an exhausted quota still cost a download,
    // every single cycle, only to throw the result away.
    it('does not pull a story from the source when the quota is already exhausted', async () => {
      const { reader, asked } = stubReader(['peer:1']);

      const bridge = createTgToIgBridge(
        reader,
        neverPublishes,
        store,
        {
          pollIntervalMs: 60_000,
          monitoredPeers: ['@someone'],
          alertAfterFailures: 0,
          instagram: () => ({ accountId: '', accessToken: '' }),
          quota: {
            ensureCapacity: () => Promise.reject(QuotaExceededError.reached(100, 100, 0)),
            recordPublish: () => {},
          } as never,
          onFatal: () => {},
        },
        silentLogger
      );

      await pollOnce(bridge);

      assert.deepEqual(asked, [], 'the reader must never be asked while the quota is exhausted');
    });
  });

  describe('story ordering', () => {
    // publishStory is not injectable, so completion is read from the attempts column.
    // attemptState() cannot tell: the first backoff is 0, so it reads 'ready' before and after.
    it('publishes a story before asking the reader for the next one', async () => {
      const order: string[] = [];
      const reader: StorySource = {
        stories: async function* () {
          order.push('yield 1');
          yield story('peer:1');
          order.push((await attemptsFor('peer:1')) > 0 ? 'publish 1' : 'no publish 1');
          order.push('yield 2');
          yield story('peer:2');
        },
        notifySelf: async () => {},
        isConnected: () => true,
        reconnect: async () => {},
      };

      await pollOnce(bridgeOver(reader));

      assert.deepEqual(order, ['yield 1', 'publish 1', 'yield 2']);
    });
  });

  describe('stop', () => {
    // A for-await break calls the generator's return(), so code after the yield never runs;
    // completion is read from the clock and the store instead of a flag in the stub.
    it('waits for the in-flight cycle, and publishes nothing past it', async () => {
      const reader: StorySource = {
        stories: async function* () {
          yield story('peer:1');
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield story('peer:2');
        },
        notifySelf: async () => {},
        isConnected: () => true,
        reconnect: async () => {},
      };

      const bridge = bridgeOver(reader);
      bridge.start();

      // Long enough for the first story to be published, well short of the
      // 50ms the stub waits before offering the second.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const before = Date.now();
      await bridge.stop();

      assert.ok(
        Date.now() - before >= 30,
        'stop() must wait out the in-flight cycle rather than return early'
      );
      assert.ok((await attemptsFor('peer:1')) > 0, 'the story already in flight must be attempted');
      assert.equal(
        await attemptsFor('peer:2'),
        0,
        'a story offered after running went false must not be attempted'
      );
    });

    // Unlike the reader's own delay above, a publish stuck waiting on its Instagram container
    // is abortable: stop() must cut it short rather than wait out the full multi-minute timeout.
    it('cuts a slow publish short instead of waiting it out, at no cost to the story', async () => {
      const meta = new MetaStub();
      await meta.start();
      const mediaServer = new MediaServer(
        {
          port: MEDIA_PORT,
          host: '127.0.0.1',
          publicBaseUrl: `http://127.0.0.1:${MEDIA_PORT}`,
          ttlMs: 60_000,
        },
        silentLogger
      );
      await mediaServer.start();
      // Never finishes on its own, so nothing but the abort can end this publish.
      meta.statusSequence = ['IN_PROGRESS'];

      try {
        const { reader, alerts } = stubReader(['peer:1']);
        const bridge = createTgToIgBridge(
          reader,
          mediaServer,
          store,
          {
            pollIntervalMs: 60_000,
            monitoredPeers: ['@someone'],
            alertAfterFailures: 1,
            instagram: () => ({ accountId: 'acct_1', accessToken: 'token_abc', apiBase: meta.url }),
            quota: {
              ensureCapacity: async () => {},
              recordPublish: () => {},
            } as never,
            onFatal: () => {},
          },
          silentLogger
        );

        bridge.start();
        // Long enough for the container to be created and the first poll wait to begin, well
        // short of that wait's own multi-second delay.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const before = Date.now();
        await bridge.stop();

        assert.ok(
          Date.now() - before < 1_000,
          'stop() must not wait out the publish timeout for an abortable wait'
        );
        assert.equal(
          await attemptsFor('peer:1'),
          0,
          'an interrupted attempt must not be counted as a failure'
        );
        assert.equal(alerts.length, 0, 'must not alert over a publish that was never attempted');
      } finally {
        await mediaServer.stop();
        await meta.stop();
      }
    });
  });

  /** Pulls every failure timestamp back so the next cycle is due immediately. */
  async function rewindBackoff() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state.db'));
    db.exec(`UPDATE stories SET processed_at = datetime('now', '-500 minutes')`);
    db.close();
  }

  /** How many attempts the store has recorded for a story, 0 if it was never touched. */
  async function attemptsFor(id: string): Promise<number> {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state.db'));
    const row = db.prepare('SELECT attempts FROM stories WHERE story_id = ?').get(id) as
      { attempts?: number } | undefined;
    db.close();
    return row?.attempts ?? 0;
  }
});
