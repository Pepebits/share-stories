import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishStory, PermanentError, getAccountInfo } from '../src/instagram/graph-api.js';
import { MediaServer } from '../src/http/media-server.js';
import type { InstagramPublishConfig, PublishTiming } from '../src/instagram/types.js';
import type { StoryMedia } from '../src/telegram/types.js';
import { MetaStub, metaError } from './helpers/meta-stub.js';
import { silentLogger } from './helpers/logger.js';

const META_PORT = 45810;
const MEDIA_PORT = 45811;

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
    sourcePlatform: 'telegram',
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
    await meta.start(META_PORT);

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

    it('keeps polling through a transient status read failure', async () => {
      meta.statusResponses = [{ status: 503, body: { error: { message: 'try later' } } }];
      meta.statusSequence = ['FINISHED'];

      const mediaId = await publishStory(story(), config, mediaServer, silentLogger, FAST);
      assert.equal(mediaId, 'published_media_1');
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
    await meta.start(META_PORT + 2);
  });

  afterEach(async () => {
    await meta.stop();
  });

  it('returns null instead of throwing when the token is rejected', async () => {
    meta.statusResponses = [metaError(401, 'Invalid token')];

    const info = await getAccountInfo(
      { accountId: 'acct_1', accessToken: 'bad', apiBase: meta.url },
      silentLogger
    );

    assert.equal(info, null);
  });
});
