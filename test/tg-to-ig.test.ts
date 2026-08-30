import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTgToIgBridge } from '../src/bridge/tg-to-ig.js';
import { StateStore, MAX_ATTEMPTS } from '../src/db/state.js';
import type { TelegramStoryReader } from '../src/telegram/reader.js';
import type { StoryMedia } from '../src/telegram/types.js';
import type { MediaServer } from '../src/http/media-server.js';
import { silentLogger } from './helpers/logger.js';

/**
 * The reader downloads everything it returns, so what the bridge asks it for
 * is the whole cost control. Ten stories that could never succeed once cost
 * 1563 publishes and some 4700 requests to Meta; the gate below is what keeps
 * that bounded, in both directions.
 */
describe('createTgToIgBridge', () => {
  let dir: string;
  let store: StateStore;

  const story = (id: string): StoryMedia => ({
    id,
    sourceUser: '@someone',
    sourcePlatform: 'telegram',
    mediaType: 'photo',
    buffer: Buffer.from('bytes'),
    timestamp: 1_700_000_000,
  });

  /** Records the predicate the bridge hands the reader, and what it allowed. */
  const stubReader = (available: string[]) => {
    const asked: string[][] = [];

    const reader = {
      getStoriesForPeers: (_peers: string[], isWanted: (id: string) => boolean = () => true) => {
        const allowed = available.filter((id) => isWanted(id));
        asked.push(allowed);
        return Promise.resolve(allowed.map(story));
      },
    } as unknown as TelegramStoryReader;

    return { reader, asked };
  };

  const neverPublishes = {
    host: () => ({ url: 'http://example.invalid/x.jpg', release: () => {} }),
  } as unknown as MediaServer;

  const bridgeOver = (reader: TelegramStoryReader) =>
    createTgToIgBridge(
      reader,
      neverPublishes,
      store,
      {
        pollIntervalMs: 60_000,
        monitoredPeers: ['@someone'],
        // Publishing is not configured, so every attempt fails permanently —
        // which is exactly what exercises the retry accounting.
        instagram: () => ({ accountId: '', accessToken: '' }),
        quota: {
          ensureCapacity: async () => {},
          recordPublish: () => {},
        } as never,
      },
      silentLogger
    );

  /** Runs exactly one poll cycle. */
  const pollOnce = async (bridge: ReturnType<typeof bridgeOver>) => {
    bridge.start();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.stop();
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
      store.retryState('peer:1', 'telegram', 'instagram'),
      'exhausted',
      'the story should be written off'
    );
    assert.deepEqual(asked.at(-1), [], 'and never fetched again');
    assert.ok(
      asked.filter((batch) => batch.length > 0).length <= MAX_ATTEMPTS,
      `at most ${MAX_ATTEMPTS} cycles should have fetched it`
    );
  });

  /** Pulls every failure timestamp back so the next cycle is due immediately. */
  async function rewindBackoff() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state.db'));
    db.exec(`UPDATE stories SET processed_at = datetime('now', '-500 minutes')`);
    db.close();
  }
});
