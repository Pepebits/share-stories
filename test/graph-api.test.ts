import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishStory,
  PermanentError,
  PublishAbortedError,
  getAccountInfo,
} from '../src/instagram/graph-api.js';
import { MediaServer } from '../src/http/media-server.js';
import type { InstagramPublishConfig, PublishTiming } from '../src/instagram/types.js';
import type { StoryMedia } from '../src/telegram/types.js';
import { MetaStub, metaError } from './helpers/meta-stub.js';
import { silentLogger } from './helpers/logger.js';

// Below the ephemeral range, so no outgoing connection can be holding it. See MetaStub.start.
const MEDIA_PORT = 25811;

/** Production waits minutes; these collapse it to milliseconds. */
const FAST: PublishTiming = {
  pollDelaysMs: [5],
  pollTimeoutMs: 2_000,
  maxRetries: 2,
  retryBaseDelayMs: 5,
  retryMaxDelayMs: 10,
};

const photoBytes = Buffer.from('fake-jpeg-payload');

function story(overrides: Partial<StoryMedia> = {}): StoryMedia {
  return {
    id: 'tg_story_1',
    sourceUser: '@somechannel',
    mediaType: 'photo',
    buffer: photoBytes,
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

describe('publishStory', () => {
  let meta: MetaStub;
  let mediaServer: MediaServer;
  let config: InstagramPublishConfig;

  beforeEach(async () => {
    meta = new MetaStub();
    await meta.start();

    mediaServer = new MediaServer(
      {
        port: MEDIA_PORT,
        host: '127.0.0.1',
        publicBaseUrl: `http://127.0.0.1:${MEDIA_PORT}`,
        ttlMs: 60_000,
      },
      silentLogger
    );
    await mediaServer.start();

    config = { accountId: 'acct_1', accessToken: 'token_abc', apiBase: meta.url };
  });

  afterEach(async () => {
    await mediaServer.stop();
    await meta.stop();
  });

  describe('the happy path', () => {
    it('creates a STORIES container, polls it, and publishes it', async () => {
      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');

      const create = meta.callsTo('POST', '/media')[0];
      assert.equal(create.path, '/acct_1/media');
      assert.equal(create.body?.media_type, 'STORIES');
      assert.equal(create.authorization, 'Bearer token_abc');

      const publish = meta.callsTo('POST', '/media_publish')[0];
      assert.equal(publish.body?.creation_id, 'container_1');
    });

    it('sends image_url for photos and video_url for videos', async () => {
      await publishStory(story(), config, mediaServer, silentLogger, FAST);
      const photoCall = meta.callsTo('POST', '/media')[0];
      assert.ok(photoCall.body?.image_url, 'photo should use image_url');
      assert.equal(photoCall.body?.video_url, undefined);

      meta.calls.length = 0;
      await publishStory(
        story({ mediaType: 'video', id: 'tg_story_2' }),
        config,
        mediaServer,
        silentLogger,
        FAST
      );
      const videoCall = meta.callsTo('POST', '/media')[0];
      assert.ok(videoCall.body?.video_url, 'video should use video_url');
      assert.equal(videoCall.body?.image_url, undefined);
    });

    it('serves the real bytes to Meta at the URL it was handed', async () => {
      meta.downloadMedia = true;
      await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(meta.downloadStatus, 200);
      assert.ok(meta.downloadedBytes?.equals(photoBytes), 'Meta must receive the story bytes');
    });

    it('keeps polling while the container is still processing', async () => {
      meta.statusSequence = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');
      assert.equal(meta.calls.filter((c) => c.method === 'GET').length, 3);
    });
  });

  describe('permanent failures', () => {
    it('treats a container ERROR as permanent', async () => {
      meta.statusSequence = ['IN_PROGRESS', 'ERROR'];

      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        (error: Error) => {
          assert.ok(error instanceof PermanentError);
          assert.match(error.message, /ERROR/);
          return true;
        }
      );
      assert.equal(meta.callsTo('POST', '/media_publish').length, 0, 'must not publish');
    });

    // Regression: an empty Buffer is truthy, so a story Telegram sent no media for used to
    // reach Meta, which answered with a bare 500 that the retry logic read as transient.
    it('refuses to publish a story with no media bytes', async () => {
      const empty = story({ buffer: Buffer.alloc(0) });

      await assert.rejects(
        () => publishStory(empty, config, mediaServer, silentLogger, FAST),
        (error: Error) => {
          assert.ok(error instanceof PermanentError);
          assert.match(error.message, /the media is empty/);
          return true;
        }
      );

      assert.equal(meta.callsTo('POST', '/media').length, 0, 'must not reach Meta at all');
    });

    it('treats an EXPIRED container as permanent', async () => {
      meta.statusSequence = ['EXPIRED'];
      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        PermanentError
      );
    });

    // Regression: a rejected token used to burn all three attempts before
    // reporting the one thing the operator needed to see.
    it('does not retry a rejected token', async () => {
      meta.createResponses = [metaError(400, 'Invalid OAuth access token', 190)];

      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        (error: Error) => {
          assert.ok(error instanceof PermanentError);
          assert.match(error.message, /Invalid OAuth access token/);
          return true;
        }
      );

      assert.equal(meta.callsTo('POST', '/media').length, 1, 'should attempt exactly once');
    });

    it('surfaces Meta error codes rather than a bare HTTP status', async () => {
      meta.createResponses = [metaError(400, 'Media could not be fetched', 9004, 2207052)];

      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        (error: Error) => {
          assert.match(error.message, /Media could not be fetched/);
          assert.match(error.message, /code=9004/);
          assert.match(error.message, /subcode=2207052/);
          assert.match(error.message, /fbtrace_id=/);
          return true;
        }
      );
    });

    it('stops polling when the status endpoint rejects the token', async () => {
      meta.statusResponses = [metaError(401, 'Token expired', 190)];

      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        PermanentError
      );
      assert.equal(meta.calls.filter((c) => c.method === 'GET').length, 1);
    });

    it('refuses to publish when credentials are missing, without any network call', async () => {
      await assert.rejects(
        () =>
          publishStory(
            story(),
            { accountId: '', accessToken: '', apiBase: meta.url },
            mediaServer,
            silentLogger,
            FAST
          ),
        PermanentError
      );
      assert.equal(meta.calls.length, 0);
    });

    it('gives up when the container never finishes', async () => {
      meta.statusSequence = ['IN_PROGRESS'];

      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST),
        /timeout/i
      );
    });
  });

  describe('transient failures', () => {
    it('retries a 5xx and succeeds', async () => {
      meta.createResponses = [{ status: 500, body: { error: { message: 'Internal error' } } }];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');
      assert.equal(meta.callsTo('POST', '/media').length, 2, 'should retry once then succeed');
    });

    it('retries a 429 rather than treating it as permanent', async () => {
      meta.publishResponses = [metaError(429, 'Rate limit reached', 4)];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');
      assert.equal(meta.callsTo('POST', '/media_publish').length, 2);
    });

    // Regression: Meta sends rate limiting as a plain 400, not 429, and the client used to
    // read every 4xx as permanent and give up after one attempt.
    it('retries a 400 flagged is_transient', async () => {
      meta.createResponses = [
        {
          status: 400,
          body: { error: { message: 'Please retry', code: 99999, is_transient: true } },
        },
      ];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');
      assert.equal(meta.callsTo('POST', '/media').length, 2);
    });

    it('retries a 400 carrying a known transient error code', async () => {
      // Code 4: "Application request limit reached" — sent as a 400, never a 429.
      meta.createResponses = [metaError(400, 'Application request limit reached', 4)];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'published_media_1');
      assert.equal(meta.callsTo('POST', '/media').length, 2);
    });

    it('keeps polling through a transient status read failure', async () => {
      meta.statusResponses = [{ status: 503, body: { error: { message: 'try later' } } }];
      meta.statusSequence = ['FINISHED'];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);
      assert.equal(mediaId, 'published_media_1');
    });

    // Regression: retrying media_publish blind after a lost response either double-posts the
    // story (Meta already committed it) or turns "already published" into a permanent failure
    // that a later cycle retries with a fresh container — a duplicate story either way.
    it('treats a lost publish response as success once the container reads PUBLISHED', async () => {
      meta.publishResponses = [{ status: 500, body: { error: { message: 'Internal error' } } }];
      // First GET is waitForContainer's poll; the retry's confirmation check gets the second.
      meta.statusSequence = ['FINISHED', 'PUBLISHED'];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);

      assert.equal(mediaId, 'container_1', 'falls back to the container id; no media id exists');
      assert.equal(
        meta.callsTo('POST', '/media_publish').length,
        1,
        'must not publish the container a second time'
      );
    });
  });

  // stop() aborts an in-flight publish so shutdown isn't held hostage by a slow one — but only
  // up to the point media_publish is sent, past which Meta may already have committed it.
  describe('cancellation', () => {
    it('rejects promptly with PublishAbortedError when aborted during the container wait, without publishing', async () => {
      // Never finishes on its own, so the only way this test settles is via the abort.
      meta.statusSequence = ['IN_PROGRESS'];
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      const before = Date.now();
      await assert.rejects(
        () => publishStory(story(), config, mediaServer, silentLogger, FAST, controller.signal),
        PublishAbortedError
      );
      const elapsed = Date.now() - before;

      assert.ok(
        elapsed < FAST.pollTimeoutMs,
        `must reject well before the ${FAST.pollTimeoutMs}ms poll timeout, took ${elapsed}ms`
      );
      assert.equal(
        meta.callsTo('POST', '/media_publish').length,
        0,
        'must not publish once aborted'
      );
    });

    it('lets media_publish finish once it has started, even if the signal fires mid-flight', async () => {
      // Long enough that the abort below is guaranteed to land while the request is in flight.
      meta.publishDelayMs = 150;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 40);

      const mediaId = await publishStory(
        story(),
        config,
        mediaServer,
        silentLogger,
        FAST,
        controller.signal
      );

      assert.equal(mediaId, 'published_media_1', 'the publish must complete despite the abort');
      assert.equal(meta.callsTo('POST', '/media_publish').length, 1);
    });
  });

  // The hosted URL is an unauthenticated handle on the media; leaving it live
  // after the publish attempt would leak the story to anyone who saw the URL.
  describe('media URL lifecycle', () => {
    it('revokes the URL after a successful publish', async () => {
      await publishStory(story(), config, mediaServer, silentLogger, FAST);

      const mediaUrl = meta.callsTo('POST', '/media')[0].body?.image_url as string;
      assert.equal((await fetch(mediaUrl)).status, 404);
    });

    it('revokes the URL even when publishing fails', async () => {
      meta.statusSequence = ['ERROR'];

      await assert.rejects(() => publishStory(story(), config, mediaServer, silentLogger, FAST));

      const mediaUrl = meta.callsTo('POST', '/media')[0].body?.image_url as string;
      assert.equal((await fetch(mediaUrl)).status, 404);
    });
  });
});

describe('getAccountInfo', () => {
  let meta: MetaStub;

  beforeEach(async () => {
    meta = new MetaStub();
    await meta.start();
  });

  afterEach(async () => {
    await meta.stop();
  });

  it('throws a PermanentError, without retrying, when the token is rejected', async () => {
    meta.statusResponses = [metaError(401, 'Invalid token')];

    await assert.rejects(
      () =>
        getAccountInfo(
          { accountId: 'acct_1', accessToken: 'bad', apiBase: meta.url },
          silentLogger
        ),
      (error: Error) => {
        assert.ok(error instanceof PermanentError);
        assert.match(error.message, /credentials rejected/);
        assert.match(error.message, /Invalid token/);
        return true;
      }
    );
    assert.equal(meta.calls.length, 1, 'a rejected token must not be retried');
  });

  it('retries a transient failure and succeeds once Meta recovers', async () => {
    meta.statusResponses = [
      { status: 500, body: { error: { message: 'Internal error' } } },
      { status: 200, body: { id: 'acct_1', username: 'realuser' } },
    ];

    const info = await getAccountInfo(
      { accountId: 'acct_1', accessToken: 'token_abc', apiBase: meta.url },
      silentLogger
    );

    assert.deepEqual(info, { id: 'acct_1', username: 'realuser' });
    assert.equal(meta.calls.length, 2);
  });

  // A boot-time network blip must not read the same as a bad token.
  it('reports Meta as unreachable, not credentials as rejected, once retries are exhausted', async () => {
    meta.statusResponses = [
      { status: 503, body: { error: { message: 'try later' } } },
      { status: 503, body: { error: { message: 'try later' } } },
      { status: 503, body: { error: { message: 'try later' } } },
    ];

    await assert.rejects(
      () =>
        getAccountInfo(
          { accountId: 'acct_1', accessToken: 'token_abc', apiBase: meta.url },
          silentLogger
        ),
      (error: Error) => {
        assert.ok(!(error instanceof PermanentError));
        assert.match(error.message, /could not be reached/i);
        return true;
      }
    );
  });
});
