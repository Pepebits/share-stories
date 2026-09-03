import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MediaServer } from '../src/http/media-server.js';
import { silentLogger } from './helpers/logger.js';

// Below the ephemeral range, so no outgoing connection can be holding them. See MetaStub.start.
const PORT = 25790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HEALTH_PORT = 25791;

/** 4KB of recognisable bytes so slices can be compared exactly. */
const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

describe('MediaServer', () => {
  let server: MediaServer;

  before(async () => {
    server = new MediaServer(
      { port: PORT, host: '127.0.0.1', publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      silentLogger
    );
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it('mints an unguessable URL under the public origin', () => {
    const { url, release } = server.host(payload, 'video');
    assert.match(url, new RegExp(`^${ORIGIN}/media/[A-Za-z0-9_-]{43}\\.mp4$`));
    release();
  });

  it('serves the media byte-for-byte', async () => {
    const { url, release } = server.host(payload, 'video');
    const response = await fetch(url);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(payload));
    release();
  });

  it('uses the right content type and extension per media kind', async () => {
    const { url, release } = server.host(Buffer.from('jpeg bytes'), 'photo');
    assert.ok(url.endsWith('.jpg'));
    assert.equal((await fetch(url)).headers.get('content-type'), 'image/jpeg');
    release();
  });

  it('gives every item a distinct token', () => {
    const a = server.host(payload, 'photo');
    const b = server.host(payload, 'photo');
    assert.notEqual(a.url, b.url);
    a.release();
    b.release();
  });

  // Meta fetches video with range requests; answering 200 to a Range header
  // makes some of those fetches fail outright.
  describe('range requests', () => {
    it('serves a closed range as 206', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { headers: { Range: 'bytes=100-199' } });
      const body = Buffer.from(await response.arrayBuffer());

      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 100-199/4096');
      assert.equal(body.length, 100);
      assert.ok(body.equals(payload.subarray(100, 200)));
      release();
    });

    it('serves an open-ended range to EOF', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { headers: { Range: 'bytes=4000-' } });

      assert.equal(response.headers.get('content-range'), 'bytes 4000-4095/4096');
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(payload.subarray(4000)));
      release();
    });

    it('serves a suffix range as the final N bytes', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { headers: { Range: 'bytes=-500' } });

      assert.ok(Buffer.from(await response.arrayBuffer()).equals(payload.subarray(4096 - 500)));
      release();
    });

    it('rejects a range past EOF with 416', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { headers: { Range: 'bytes=9000-9999' } });

      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */4096');
      release();
    });

    it('rejects a malformed range with 416', async () => {
      const { url, release } = server.host(payload, 'video');
      assert.equal((await fetch(url, { headers: { Range: 'chunks=1-2' } })).status, 416);
      release();
    });
  });

  describe('methods', () => {
    it('answers HEAD with headers and no body', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { method: 'HEAD' });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), '4096');
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      release();
    });

    it('rejects anything that is not GET or HEAD', async () => {
      const { url, release } = server.host(payload, 'video');
      const response = await fetch(url, { method: 'POST' });

      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      release();
    });
  });

  describe('health endpoint', () => {
    it('answers without any credential', async () => {
      const response = await fetch(`${ORIGIN}/health`);

      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    });

    it('answers HEAD too, for probes that use it', async () => {
      assert.equal((await fetch(`${ORIGIN}/health`, { method: 'HEAD' })).status, 200);
    });

    // It is reachable by anyone who can reach the proxy, so it must not
    // become an inventory of what is currently hosted.
    it('discloses nothing about hosted media', async () => {
      const { url, release } = server.host(payload, 'video');
      const body = await (await fetch(`${ORIGIN}/health`)).text();

      assert.equal(body.includes(url.split('/media/')[1]), false);
      assert.equal(body, 'ok');
      release();
    });

    it('is not confused by a query string', async () => {
      assert.equal((await fetch(`${ORIGIN}/health?probe=1`)).status, 200);
    });
  });

  describe('health backed by isHealthy', () => {
    const origin = `http://127.0.0.1:${HEALTH_PORT}`;
    let healthy = true;
    let checked: MediaServer;

    before(async () => {
      checked = new MediaServer(
        {
          port: HEALTH_PORT,
          host: '127.0.0.1',
          publicBaseUrl: origin,
          ttlMs: 60_000,
          isHealthy: () => healthy,
        },
        silentLogger
      );
      await checked.start();
    });

    after(async () => {
      await checked.stop();
    });

    it('answers 503 when the check reports unhealthy', async () => {
      healthy = false;
      const response = await fetch(`${origin}/health`);
      assert.equal(response.status, 503);
      assert.equal(await response.text(), 'unavailable');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });

    it('answers HEAD with 503 too, for the Dockerfile healthcheck', async () => {
      healthy = false;
      const response = await fetch(`${origin}/health`, { method: 'HEAD' });
      assert.equal(response.status, 503);
    });

    it('answers 200 once the check reports healthy again', async () => {
      healthy = true;
      const response = await fetch(`${origin}/health`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    });
  });

  describe('isolation', () => {
    it('404s an unknown token', async () => {
      const { url, release } = server.host(payload, 'video');
      const wrong = url.replace(/\/media\/./, '/media/z');
      assert.equal((await fetch(wrong)).status, 404);
      release();
    });

    it('404s traversal attempts', async () => {
      assert.equal((await fetch(`${ORIGIN}/media/../../etc/passwd`)).status, 404);
      assert.equal((await fetch(`${ORIGIN}/../package.json`)).status, 404);
      assert.equal((await fetch(`${ORIGIN}/`)).status, 404);
    });

    it('does not leak one item through another token', async () => {
      const secret = server.host(Buffer.from('secret'), 'photo');
      const other = server.host(Buffer.from('other'), 'photo');

      const body = await (await fetch(other.url)).text();
      assert.equal(body, 'other');

      secret.release();
      other.release();
    });
  });

  it('stops resolving once released', async () => {
    const { url, release } = server.host(payload, 'video');
    assert.equal((await fetch(url)).status, 200);

    release();
    assert.equal((await fetch(url)).status, 404);
  });

  it('stops resolving once the TTL lapses', async () => {
    const shortLived = new MediaServer(
      {
        port: PORT + 1,
        host: '127.0.0.1',
        publicBaseUrl: `http://127.0.0.1:${PORT + 1}`,
        ttlMs: 120,
      },
      silentLogger
    );
    await shortLived.start();

    const { url } = shortLived.host(Buffer.from('ephemeral'), 'photo');
    assert.equal((await fetch(url)).status, 200);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await fetch(url)).status, 404);

    await shortLived.stop();
  });

  it('closes the port on stop', async () => {
    const temp = new MediaServer(
      {
        port: PORT + 2,
        host: '127.0.0.1',
        publicBaseUrl: `http://127.0.0.1:${PORT + 2}`,
        ttlMs: 60_000,
      },
      silentLogger
    );
    await temp.start();
    await temp.stop();

    await assert.rejects(() => fetch(`http://127.0.0.1:${PORT + 2}/`));
  });
});
