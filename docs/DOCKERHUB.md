# share-stories

Reposts stories from monitored Telegram peers to Instagram, using Instagram's
official Content Publishing API.

**Source and full documentation:** https://github.com/Pepebits/share-stories

```bash
docker pull pepebits/share-stories
```

Multi-architecture (`amd64`, `arm64`). No native modules — SQLite comes from
Node itself.

---

## What it needs to work

Meta does not accept file uploads: it **downloads** each story from a URL you
serve. So this container must sit behind a public HTTPS origin — a Cloudflare
tunnel, Caddy, nginx, anything with a real certificate.

Port `8080` serves that media at single-use, unguessable URLs that are revoked
as soon as Meta fetches them. **Never publish it straight to the internet.**

## Environment variables

### Required

| Variable | What it is |
|---|---|
| `PUBLIC_BASE_URL` | The public HTTPS address **Meta** resolves, e.g. `https://stories.example.com`. Not the container's port. Startup refuses a loopback or private address. |
| `TELEGRAM_API_ID` | From [my.telegram.org/apps](https://my.telegram.org/apps) |
| `TELEGRAM_API_HASH` | From the same place |
| `TELEGRAM_PHONE_NUMBER` | Of the account that reads the stories, E.164 (`+34600000000`) |
| `TELEGRAM_SESSION_STRING` | Produced by a one-off interactive login — see below |
| `TELEGRAM_MONITORED_PEERS` | Comma-separated. A peer can be named by any of its usernames, by title, or by numeric id |
| `INSTAGRAM_ACCOUNT_ID` | Numeric id of an Instagram **Business or Creator** account |
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived token, starts with `IGAA` |

### Optional

| Variable | Default | What it does |
|---|---|---|
| `MEDIA_SERVER_HOST` | `127.0.0.1` | **Set to `0.0.0.0` in Docker** — loopback is unreachable from another container |
| `MEDIA_SERVER_PORT` | `8080` | Port the media server binds |
| `MEDIA_URL_TTL_SECONDS` | `600` | How long a media URL stays valid if Meta never fetches it |
| `POLL_INTERVAL_SECONDS` | `120` | How often Telegram is checked |
| `INSTAGRAM_QUOTA_RESERVE` | `0` | Publishes held back from the 100/24h quota, so you can still post by hand |
| `INSTAGRAM_QUOTA_REFRESH_SECONDS` | `600` | How long a quota reading is trusted |
| `INSTAGRAM_TOKEN_FILE` | `./data/instagram-token.json` | Where the rotating token is stored |
| `DATABASE_PATH` | `./data/state.db` | Deduplication database |
| `TEMP_DIR` | `./data/temp` | Scratch space for downloads |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

## The volume matters

Mount `/app/data`. It holds the Telegram session, the rotating Instagram token
and the deduplication database. **Losing it means re-authenticating by hand and
republishing every story still active.**

## First run

`TELEGRAM_SESSION_STRING` cannot be obtained inside a detached container:
Telegram sends a login code that has to be typed in. Run the one-off login on
any machine with Node 24.19+:

```bash
git clone https://github.com/Pepebits/share-stories && cd share-stories
pnpm install && pnpm run login
```

Then copy the resulting string into `TELEGRAM_SESSION_STRING`.

> That string is an **unscoped credential for the whole Telegram account** —
> it can read every private message and send as you. Keep it out of images, out
> of version control, and out of anywhere it might be logged. It can be revoked
> instantly from **Telegram → Settings → Devices**.

## Example

```yaml
services:
  bridge:
    image: pepebits/share-stories:latest
    restart: unless-stopped
    init: true
    env_file: .env
    environment:
      MEDIA_SERVER_HOST: 0.0.0.0
      PUBLIC_BASE_URL: https://stories.example.com
    volumes:
      - ./data:/app/data
    ports:
      # Loopback only: your reverse proxy reaches it, the internet does not.
      - '127.0.0.1:8080:8080'
```

`GET /health` returns `200 ok` for proxy and container health checks, and
discloses nothing about what is hosted.

## Instagram setup

Getting `INSTAGRAM_ACCOUNT_ID` and `INSTAGRAM_ACCESS_TOKEN` out of Meta's
console is the fiddliest part, and its documentation contradicts its own
dashboard in places. Step by step:
[docs/INSTAGRAM_SETUP.md](https://github.com/Pepebits/share-stories/blob/main/docs/INSTAGRAM_SETUP.md)

## Tags

| Tag | Meaning |
|---|---|
| `1.0.0` | Exact version, never moves |
| `1.0` | Newest patch of that minor series |
| `latest` | Newest release |

Pin `1.0.0` if you want reproducibility; use `1.0` to pick up patches.

## Licence

MIT
