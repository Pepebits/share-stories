# Share Stories

Reposts stories from monitored Telegram peers to Instagram, using Instagram's
official Content Publishing API.

```
┌──────────────────┐                      ┌──────────────────┐
│  Telegram Story  │                      │  Instagram Story │
│    (source)      │─────── bridge ──────▶│    (target)      │
│                  │                      │                  │
│  read via GramJS │  ┌────────────────┐  │  published via   │
│  MTProto         │  │  media server  │  │  Content         │
│                  │  │  (public URL)  │  │  Publishing API  │
└──────────────────┘  └────────────────┘  └──────────────────┘
                              ▲
                    Meta fetches the media itself
```

- **[docs/INSTAGRAM_SETUP.md](docs/INSTAGRAM_SETUP.md)** — getting the Meta app and token
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — running it locally, or in production with Docker

**Published image:** [`pepebits/share-stories`](https://hub.docker.com/r/pepebits/share-stories)
on Docker Hub, and `ghcr.io/Pepebits/share-stories` on GitHub Container
Registry. Both multi-architecture (`amd64`, `arm64`).

```bash
docker pull pepebits/share-stories
```

---

## Story audiences do not survive the crossing

Telegram stories have an audience: public, contacts, selected contacts, or
close friends. **Instagram's publishing API has none.** Every story published
through it goes to all of your followers, and there is no close-friends
equivalent to publish into.

So a close-friends story from Telegram does not arrive on Instagram as a
close-friends story. It arrives as a public one. The bridge cannot narrow the
audience — it can only refuse to carry the story.

**By default it carries everything**, which is what it did before it could read
audiences at all. To carry only what was already open:

```bash
TELEGRAM_STORY_SCOPES=public
```

Worth setting whenever `TELEGRAM_MONITORED_PEERS` names anyone but yourself.
Widening your own story is your business; widening someone else's is not.

Values are `public`, `contacts`, `selectedContacts`, `closeFriends`, or `all`.
A value that cannot be parsed falls back to `public` rather than to the
default, because a typo should not be able to publish more than you meant.
Stories with forwarding disabled are never republished.

## Before you share this with anyone

The repository is safe to share. **What it produces at runtime is not.**

`.env` and `data/` are gitignored and must stay that way. Between them they
hold:

| Secret | What it grants |
|---|---|
| `TELEGRAM_SESSION_STRING` / `data/telegram-session.txt` | **Full control of the Telegram account.** Read every private message, send messages as you. There is no read-only scope. |
| `INSTAGRAM_ACCESS_TOKEN` / `data/instagram-token.json` | Publishing to that Instagram account |
| `TELEGRAM_API_HASH` | Identifies your Telegram application |

Anyone running this needs **their own** Meta app, their own Telegram
credentials and their own session. Nothing is shared between installs, and
nothing about one person's setup belongs in another's.

Encrypting those files at rest buys very little: any key the process can read
unattended is a key an attacker on the same machine can read too. What actually
helps is what is already here — `0600` permissions, a dedicated service user,
and the fact that a Telegram session can be revoked instantly from
**Settings → Devices**. Do that first if anything looks wrong.

## Quick start

```bash
pnpm install
cp .env.example .env       # see docs/INSTAGRAM_SETUP.md for the Instagram half
pnpm run build

pnpm run login             # one-time Telegram auth, needs a real terminal
pnpm run inspect           # shows which peers have stories, and how to name them
pnpm start
```

Or with Docker, once `.env` is filled in and Telegram is authenticated:

```bash
docker compose --profile tunnel up -d      # with a Cloudflare tunnel
docker compose up -d                       # behind your own Caddy/nginx
```

Either way you need a public HTTPS URL in `PUBLIC_BASE_URL` — Meta downloads
the media from it, so it must be the address *Meta* resolves, never the
container's own port. [docs/DEPLOY.md](docs/DEPLOY.md) covers a throwaway
tunnel for testing, a stable one for production, and publishing the image.

## Why only one direction

Instagram → Telegram is **not implemented, and cannot be implemented
officially.** Meta provides no way to read another account's stories, and this
was verified rather than assumed:

- **Publishing**: `media_type=STORIES` works, but only to the authenticated account.
- **Reading**: `GET /{ig-user-id}/stories` returns *your own* stories.
  `business_discovery` exposes other business accounts' profile and posts, but not stories.
- **Webhooks**: the only story field is `story_insights`, which fires **when the
  story expires**, carries metrics only, and is delivered solely for accounts
  that authorized the app.

The Instagram Basic Display API — the usual suggestion — was shut down on
**4 December 2024**, and never supported stories anyway.

Bridging that direction needs an unofficial client, which risks the account and
breaks Meta's terms. That was a deliberate trade-off. See git history for the
removed implementation.

## Tech stack

- **Runtime** Node.js 24.19+ (ESM) · **Language** TypeScript 5.9 · **Packages** pnpm 11
- **Telegram** GramJS (MTProto) — the Bot API cannot see stories
- **Instagram** Content Publishing API, `graph.instagram.com` v26.0
- **State** SQLite via Node's built-in `node:sqlite` — no native module · **Logs** Winston

## How it works

1. GramJS polls `stories.GetAllStories` for the peers in `TELEGRAM_MONITORED_PEERS`.
2. New stories are downloaded and checked against the SQLite store.
3. The media is exposed at a temporary public URL.
4. `POST /<IG_ID>/media` creates a `STORIES` container.
5. Its `status_code` is polled until `FINISHED`.
6. `POST /<IG_ID>/media_publish` publishes it; the URL is revoked immediately.

### Publishing exactly once

A story stays visible for 24h, so a two-minute poll sees the same one around
700 times. Three things keep it to one publish: the SQLite store rejects ids it
has already handled, a guard stops overlapping poll cycles, and story ids are
qualified with the peer — they restart per peer, so two channels can both own
story `3`.

Failures are recorded but **not** treated as final: a transient rejection is
retried on the next cycle. Permanent ones (rejected token, media Meta refuses)
are not retried. Stories interrupted mid-publish by a crash are recovered at
startup instead of staying blocked forever.

### Token rotation

Long-lived Instagram tokens expire after 60 days, and refreshing mints a *new*
one — so the live token cannot stay in an immutable `.env`.
`INSTAGRAM_ACCESS_TOKEN` seeds the chain; from then on the bridge refreshes
once fewer than 14 days remain and persists the result to
`INSTAGRAM_TOKEN_FILE`.

### Publish quota

100 API publishes per rolling 24h, and **stories count** — verified against the
live API. Overrunning is not cheap: Meta only refuses at `/media_publish`,
after the container is built and the media served. So the quota is checked
before each story, using `content_publishing_limit` as the authority. Hitting
it pauses the cycle rather than failing the story.

## Tests

```bash
pnpm run verify    # everything CI runs: lint, typecheck, build, tests, audit
pnpm test          # just the tests — no credentials or network needed
```

The image scan CI also performs, run locally:

```bash
docker build -t share-stories:scan .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy \
  image --severity HIGH,CRITICAL --ignore-unfixed share-stories:scan
```

93 tests, no credentials or network needed: `graph.instagram.com` is stubbed
by a local server, so the publish handshake runs end to end — container
creation, status polling, `ERROR`/`EXPIRED` containers, a rejected token
aborting without retries, 5xx and 429 retrying, and the media URL being
revoked on both success and failure.

**Not covered**: `telegram/reader.ts` (GramJS) and the startup path in
`index.ts`. Whether Meta accepts a given video, and whether it can reach
`PUBLIC_BASE_URL`, can only be learned from a real publish.

## Limitations

- **Captions are dropped**: Instagram stories do not render the caption field.
- **Media requirements**: Meta validates format server-side and a rejected file
  surfaces as a container `ERROR` with little detail.
- **No alerting**: if the bridge stops publishing, only the logs will say so.
- **One account per install**: there is no multi-tenancy, by design — see
  *Before you share this*.

## License

MIT
