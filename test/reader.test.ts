import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStoryReader } from '../src/telegram/reader.js';
import type { StoryScope } from '../src/telegram/scope.js';
import { silentLogger } from './helpers/logger.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);

type Server = Record<number, Record<string, unknown>>;

const story = (id: number, flags: Record<string, unknown> = { public: true }) => ({
  className: 'StoryItem',
  id,
  date: id,
  media: { photo: { sizes: [{ size: 10 }] } },
  ...flags,
});

/**
 * A fake teleproto client. `server` is the truth Telegram would answer with; the feed snapshot
 * is a copy taken when GetAllStories is called, so tests can change the truth afterwards.
 */
function fakeClient(server: Server, options: { failById?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    connected: true,
    getInputEntity: (peer: unknown) => Promise.resolve(peer),
    invoke(request: { className: string; id?: number[] }) {
      calls.push(request.className);
      if (request.className === 'stories.GetAllStories') {
        return Promise.resolve({
          peerStories: [
            {
              peer: { userId: 1001n },
              stories: Object.values(server).map((entry) => ({ ...entry })),
            },
          ],
          users: [{ id: 1001n, username: 'dummy_peer' }],
          chats: [],
        });
      }
      if (request.className === 'stories.GetStoriesByID') {
        if (options.failById) return Promise.reject(new Error('flood'));
        return Promise.resolve({
          stories: (request.id ?? []).flatMap((id) => (server[id] ? [{ ...server[id] }] : [])),
        });
      }
      return Promise.reject(new Error(`unexpected ${request.className}`));
    },
    downloadMedia: () => Promise.resolve(jpeg),
  };
}

function readerWith(client: unknown, allowedScopes: StoryScope[] = ['public']) {
  const reader = new TelegramStoryReader(
    { apiId: 1, apiHash: 'x', phoneNumber: '', sessionString: '', allowedScopes },
    silentLogger
  );
  (reader as unknown as { client: unknown }).client = client;
  return reader;
}

async function collect(reader: TelegramStoryReader): Promise<string[]> {
  const ids: string[] = [];
  for await (const item of reader.stories(['dummy_peer'])) ids.push(item.id);
  return ids;
}

describe('TelegramStoryReader audience re-check', () => {
  it('publishes a story whose fresh copy is still allowed', async () => {
    const client = fakeClient({ 1: story(1) });
    assert.deepEqual(await collect(readerWith(client)), ['1001:1']);
    assert.ok(client.calls.includes('stories.GetStoriesByID'));
  });

  it('drops a story narrowed to close friends after the feed snapshot', async () => {
    const server: Server = { 1: story(1), 2: story(2) };
    const reader = readerWith(fakeClient(server));
    const yielded: string[] = [];

    for await (const item of reader.stories(['dummy_peer'])) {
      yielded.push(item.id);
      // While the consumer publishes story 1, the author narrows story 2.
      if (item.id === '1001:1') server[2] = story(2, { closeFriends: true });
    }

    assert.deepEqual(yielded, ['1001:1']);
  });

  it('drops a story that turned noforwards after the snapshot', async () => {
    const server: Server = { 1: story(1), 2: story(2) };
    const reader = readerWith(fakeClient(server));
    const yielded: string[] = [];

    for await (const item of reader.stories(['dummy_peer'])) {
      yielded.push(item.id);
      if (item.id === '1001:1') server[2] = story(2, { public: true, noforwards: true });
    }

    assert.deepEqual(yielded, ['1001:1']);
  });

  it('drops a story that was deleted after the snapshot', async () => {
    const server: Server = { 1: story(1), 2: story(2) };
    const reader = readerWith(fakeClient(server));
    const yielded: string[] = [];

    for await (const item of reader.stories(['dummy_peer'])) {
      yielded.push(item.id);
      if (item.id === '1001:1') delete server[2];
    }

    assert.deepEqual(yielded, ['1001:1']);
  });

  it('skips the story when the re-fetch fails instead of trusting stale flags', async () => {
    const client = fakeClient({ 1: story(1) }, { failById: true });
    assert.deepEqual(await collect(readerWith(client)), []);
  });

  it('does not re-fetch a story the snapshot already refuses', async () => {
    const client = fakeClient({ 1: story(1, { closeFriends: true }) });
    assert.deepEqual(await collect(readerWith(client)), []);
    assert.ok(!client.calls.includes('stories.GetStoriesByID'));
  });
});

describe('TelegramStoryReader.notifySelf', () => {
  it('sends with Markdown parsing off so error text cannot add links', async () => {
    const sent: { target: unknown; params: Record<string, unknown> }[] = [];
    const client = {
      sendMessage: (target: unknown, params: Record<string, unknown>) => {
        sent.push({ target, params });
        return Promise.resolve({});
      },
    };

    await readerWith(client).notifySelf('Meta said: [click](https://evil.example)');

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.target, 'me');
    assert.equal(sent[0]?.params.parseMode, false);
    assert.equal(sent[0]?.params.message, 'Meta said: [click](https://evil.example)');
  });
});
