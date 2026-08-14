import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MetaCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  authorization?: string;
}

export interface StubResponse {
  status: number;
  body: unknown;
}

/** Meta's error envelope, which the client has to unwrap from response.data. */
export function metaError(
  status: number,
  message: string,
  code = 190,
  subcode?: number
): StubResponse {
  return {
    status,
    body: {
      error: {
        message,
        type: 'OAuthException',
        code,
        ...(subcode === undefined ? {} : { error_subcode: subcode }),
        fbtrace_id: 'Axxxxxxxxxxxxxxxx',
      },
    },
  };
}

/**
 * Stands in for graph.instagram.com so the publish handshake can be exercised
 * end to end — including the failure modes that only ever show up in production.
 */
export class MetaStub {
  readonly calls: MetaCall[] = [];

  /** Statuses returned by successive container polls; the last one repeats. */
  statusSequence: string[] = ['FINISHED'];
  /** Queued overrides consumed in order; falls through to success when empty. */
  createResponses: StubResponse[] = [];
  publishResponses: StubResponse[] = [];
  statusResponses: StubResponse[] = [];
  refreshResponses: StubResponse[] = [];

  /** Increments per refresh so successive tokens are distinguishable. */
  refreshCount = 0;

  /** When true, the stub downloads the media URL exactly as Meta would. */
  downloadMedia = false;
  downloadedBytes: Buffer | null = null;
  downloadStatus: number | null = null;

  private server: Server | null = null;
  private port = 0;
  private pollCount = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  callsTo(method: string, suffix: string): MetaCall[] {
    return this.calls.filter((c) => c.method === method && c.path.endsWith(suffix));
  }

  async start(port: number): Promise<void> {
    this.port = port;
    const server = createServer((req, res) => void this.handle(req, res));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    const raw = Buffer.concat(chunks).toString();
    let body: Record<string, unknown> | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }

    const path = (req.url ?? '').split('?')[0];
    this.calls.push({
      method: req.method ?? 'GET',
      path,
      body,
      authorization: req.headers.authorization,
    });

    const reply = (response: StubResponse) => {
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    };

    if (req.method === 'POST' && path.endsWith('/media_publish')) {
      reply(this.publishResponses.shift() ?? { status: 200, body: { id: 'published_media_1' } });
      return;
    }

    if (req.method === 'POST' && path.endsWith('/media')) {
      if (this.downloadMedia) await this.download(body);
      reply(this.createResponses.shift() ?? { status: 200, body: { id: 'container_1' } });
      return;
    }

    if (req.method === 'GET' && path.endsWith('/refresh_access_token')) {
      reply(
        this.refreshResponses.shift() ?? {
          status: 200,
          body: { access_token: `refreshed_${++this.refreshCount}`, expires_in: 5_184_000 },
        }
      );
      return;
    }

    if (req.method === 'GET') {
      const override = this.statusResponses.shift();
      if (override) {
        reply(override);
        return;
      }
      const index = Math.min(this.pollCount++, this.statusSequence.length - 1);
      reply({ status: 200, body: { status_code: this.statusSequence[index], id: 'container_1' } });
      return;
    }

    reply({ status: 404, body: { error: { message: 'unknown stub route' } } });
  }

  /** Fetches the hosted media the way Meta does, so revocation can be proven. */
  private async download(body: Record<string, unknown> | null): Promise<void> {
    const mediaUrl = (body?.image_url ?? body?.video_url) as string | undefined;
    if (!mediaUrl) return;

    try {
      const response = await fetch(mediaUrl);
      this.downloadStatus = response.status;
      this.downloadedBytes = Buffer.from(await response.arrayBuffer());
    } catch {
      this.downloadStatus = 0;
    }
  }
}
