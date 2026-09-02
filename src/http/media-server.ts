import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Logger } from '../utils/logger.js';

/**
 * Meta's Content Publishing API does not accept file uploads: it fetches the
 * media itself over HTTP from a URL you provide. This server exposes each
 * story at a single-use, unguessable URL that stops resolving as soon as the
 * story is published (or the TTL lapses).
 *
 * Media is served from memory, so there is no path to traverse.
 */

const EXTENSIONS = { photo: 'jpg', video: 'mp4' } as const;
const CONTENT_TYPES = { photo: 'image/jpeg', video: 'video/mp4' } as const;

/** 32 random bytes base64url-encoded — 43 chars, 256 bits of entropy. */
const TOKEN_PATTERN = /^\/media\/([A-Za-z0-9_-]{43})\.(?:jpg|mp4)$/;

export type MediaKind = keyof typeof EXTENSIONS;

interface HostedMedia {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

export interface MediaServerConfig {
  port: number;
  /** Interface to bind. Defaults to loopback: put a TLS reverse proxy in front. */
  host: string;
  /** Public origin Meta will fetch from, e.g. https://stories.example.com */
  publicBaseUrl: string;
  ttlMs: number;
  /** Backs /health. Omitted means always healthy. */
  isHealthy?: () => boolean;
}

export interface HostedHandle {
  url: string;
  release: () => void;
}

export class MediaServer {
  private readonly items = new Map<string, HostedMedia>();
  private server: Server | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: MediaServerConfig,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    if (this.server) return;

    const server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    server.on('error', (error) => {
      this.logger.error('Media server error', { error: error.message });
    });

    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();

    this.logger.info('Media server listening', {
      bind: `${this.config.host}:${this.config.port}`,
      publicBaseUrl: this.config.publicBaseUrl,
    });
  }

  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.items.clear();

    const server = this.server;
    if (!server) return;
    this.server = null;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.logger.info('Media server stopped');
  }

  /**
   * Publish a buffer at a fresh single-use URL. Always call `release()` once
   * Meta has fetched it — the TTL is a backstop, not the primary lifecycle.
   */
  host(buffer: Buffer, kind: MediaKind): HostedHandle {
    const token = randomBytes(32).toString('base64url');

    this.items.set(token, {
      buffer,
      contentType: CONTENT_TYPES[kind],
      expiresAt: Date.now() + this.config.ttlMs,
    });

    const base = this.config.publicBaseUrl.replace(/\/+$/, '');

    return {
      url: `${base}/media/${token}.${EXTENSIONS[kind]}`,
      release: () => {
        this.items.delete(token);
      },
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, item] of this.items) {
      if (item.expiresAt <= now) {
        this.items.delete(token);
        this.logger.debug('Hosted media expired before it was fetched');
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const path = (req.url ?? '').split('?')[0];

    // Liveness only. Deliberately says nothing about stories, tokens or how
    // many items are hosted: whatever fronts this can be probed by anyone who
    // reaches it.
    if (path === '/health') {
      const healthy = this.config.isHealthy ? this.config.isHealthy() : true;
      res.writeHead(healthy ? 200 : 503, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : healthy ? 'ok' : 'unavailable');
      return;
    }

    const match = TOKEN_PATTERN.exec(path);
    const item = match ? this.items.get(match[1]) : undefined;

    // Unknown, malformed, and expired tokens are indistinguishable from outside.
    if (!item || item.expiresAt <= Date.now()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const headers: Record<string, string> = {
      'content-type': item.contentType,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };

    // Meta fetches video with range requests; serving 200 for a Range header
    // makes some fetches fail outright.
    const range = this.parseRange(req.headers.range, item.buffer.length);

    if (range === 'invalid') {
      res.writeHead(416, { 'content-range': `bytes */${item.buffer.length}` });
      res.end();
      return;
    }

    const body = range ? item.buffer.subarray(range.start, range.end + 1) : item.buffer;

    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${item.buffer.length}`;
    }
    headers['content-length'] = String(body.length);

    res.writeHead(range ? 206 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private parseRange(
    header: string | undefined,
    size: number
  ): { start: number; end: number } | null | 'invalid' {
    if (!header) return null;

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return 'invalid';

    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return 'invalid';

    // Suffix form: "bytes=-500" means the final 500 bytes.
    const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
    const end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);

    if (start > end || start >= size) return 'invalid';

    return { start, end: Math.min(end, size - 1) };
  }
}
