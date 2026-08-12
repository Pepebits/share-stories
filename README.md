# Share Historys

Reposts stories from monitored Telegram channels to Instagram, using Instagram's
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

## Why only one direction

Instagram → Telegram is **not implemented, and cannot be implemented officially.**
Meta provides no way to read another account's stories:

- **Publishing**: `media_type=STORIES` works, but only to the authenticated account.
- **Reading**: `GET /{ig-user-id}/stories` returns *your own* stories.
  `business_discovery` exposes other business accounts' profile and posts, but not stories.
- **Webhooks**: the only story field is `story_insights`, which fires **when the story
  expires** (24h late), carries metrics only (no media URL), and is delivered solely for
  accounts that have authorized the app via `/me/subscribed_apps`.

The Instagram Basic Display API — the usual suggestion — was **shut down on
4 December 2024**, and never supported stories in any case.

Bridging that direction therefore requires an unofficial client
(`instagram-private-api`, unmaintained since March 2024, or Python's `instagrapi`),
which risks the account and violates Meta's terms. That was a deliberate trade-off,
not an oversight. See git history for the removed implementation.

## Tech Stack

- **Runtime**: Node.js 22+ (ESM) · **Language**: TypeScript 5.9 · **Package manager**: pnpm 10
- **Telegram (reading)**: GramJS (`telegram`, MTProto)
- **Instagram (publishing)**: Content Publishing API via `graph.instagram.com` v25.0
- **State**: SQLite (`better-sqlite3`) · **Logging**: Winston

## Prerequisites

### Telegram

1. Create an app at [my.telegram.org](https://my.telegram.org/apps) → `api_id`, `api_hash`.
2. A Telegram user account (stories cannot be enumerated through the Bot API).
3. First run asks for the login code sent to that account.

### Instagram

1. An Instagram **Business or Creator** account.
2. A Meta app with **Instagram API with Instagram Login** configured, plus the
   `instagram_business_content_publish` permission.
3. A long-lived access token and the numeric account id.

### Networking — required

Meta downloads the media from a URL you serve; it does not accept uploads. You need a
**publicly reachable HTTPS origin** pointing at this process, e.g. Caddy or nginx in
front of `MEDIA_SERVER_PORT`. Without it, every publish fails with a container `ERROR`.

Media is held in memory and served at a single-use 256-bit URL that is revoked as
soon as Meta fetches it.

## Setup

```bash
pnpm install
cp .env.example .env    # fill in credentials
pnpm run build
pnpm start              # or: pnpm run dev
```

On first run, leave `TELEGRAM_SESSION_STRING` empty. The session is written to
`./data/telegram-session.txt` with mode `0600` — copy it into `.env` and delete the
file. It is never logged: it grants full access to the Telegram account.

## Tests

```bash
pnpm test        # node:test via tsx — no credentials or network needed
pnpm run typecheck
```

The suite stubs `graph.instagram.com` with a local server, so the publish
handshake is exercised end to end: container creation, status polling,
`ERROR`/`EXPIRED` containers, a rejected token aborting without retries, 5xx and
429 retrying, and the media URL being revoked on both success and failure.

**What it does not cover**: `telegram/reader.ts` (GramJS), `bridge/tg-to-ig.ts`,
`db/state.ts`, and the startup path in `index.ts` are untested. Whether Meta
accepts a given video's format, and whether it can reach `PUBLIC_BASE_URL`, can
only be learned from a real publish.

## How It Works

1. GramJS polls `stories.GetAllStories` for the peers in `TELEGRAM_MONITORED_PEERS`.
2. New stories are downloaded and checked against the SQLite store.
3. The media is exposed at a temporary public URL.
4. `POST /<IG_ID>/media` creates a `STORIES` container.
5. The container's `status_code` is polled until `FINISHED`.
6. `POST /<IG_ID>/media_publish` publishes it; the URL is revoked.

Failures are recorded in the state store, and permanent ones (rejected token, bad
media) are not retried.

## Deployment

```bash
sudo cp share-historys.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now share-historys
sudo journalctl -u share-historys -f
```

## Limitations

- **Captions are dropped**: Instagram stories do not render the caption field.
- **Rate limit**: 100 API-published posts per rolling 24h; check with
  `GET /<IG_ID>/content_publishing_limit`.
- **Token expiry**: long-lived tokens die after 60 days. Refresh via
  `refreshAccessToken()` or re-issue manually.
- **Media requirements**: Meta validates format server-side. A rejected video surfaces
  as a container `ERROR` with little detail.
- **Partial test coverage**: see the Tests section for what is and is not verified.

## License

MIT
