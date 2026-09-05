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

## Story audiences do not survive the crossing

Telegram stories have an audience — public, contacts, selected contacts, close
friends. Instagram's publishing API has none: everything it publishes goes to
all your followers, and there is no close-friends equivalent to publish into.

A close-friends story therefore arrives on Instagram **public**. The bridge
cannot narrow it, only decline to carry it. It carries everything by default:

```bash
TELEGRAM_STORY_SCOPES=public   # only what was already open to everyone
```

Set that whenever `TELEGRAM_MONITORED_PEERS` names anyone but yourself.

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
| `TELEGRAM_MONITORED_PEERS` | Comma-separated. A peer can be named by any of its usernames, by title, or by numeric id |
| `INSTAGRAM_ACCOUNT_ID` | Numeric id of an Instagram **Business or Creator** account |
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived token, starts with `IGAA` |

### Optional

| Variable | Default | What it does |
|---|---|---|
| `TELEGRAM_SESSION_FILE` | `./data/telegram-session.txt` | Where the session written by the one-off login lives — see below. Also where the bridge saves it when Telegram rotates it. |
| `TELEGRAM_SESSION_STRING` | — | The session as a string, for environments with no volume. Goes stale once Telegram rotates the session; the file is the better home. |
| `TELEGRAM_STORY_SCOPES` | `all` | Which story audiences to carry: `public`, `contacts`, `selectedContacts`, `closeFriends`, comma-separated, or `all`. A value that cannot be parsed falls back to `public`. |
| `ALERT_AFTER_FAILURES` | `3` | After this many consecutive publish failures, a warning is sent to the Telegram account's Saved Messages. `0` disables it. |
| `MEDIA_SERVER_HOST` | `127.0.0.1` | **Set to `0.0.0.0` in Docker** — loopback is unreachable from another container |
| `MEDIA_SERVER_PORT` | `8080` | Port the media server binds |
| `MEDIA_URL_TTL_SECONDS` | `600` | How long a media URL stays valid if Meta never fetches it |
| `POLL_INTERVAL_SECONDS` | `120` | How often Telegram is checked |
| `INSTAGRAM_QUOTA_RESERVE` | `0` | Publishes held back from the 100/24h quota, so you can still post by hand |
| `INSTAGRAM_QUOTA_REFRESH_SECONDS` | `600` | How long a quota reading is trusted |
| `INSTAGRAM_TOKEN_FILE` | `./data/instagram-token.json` | Where the rotating token is stored |
| `DATABASE_PATH` | `./data/state.db` | Deduplication database |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

## The volume matters

Mount `/app/data`. It holds the Telegram session, the rotating Instagram token
and the deduplication database. **Losing it means re-authenticating by hand and
republishing every story still active.**

## First run

The session cannot be obtained inside a detached container: Telegram sends a
login code that has to be typed in. Run the one-off login on any machine with
Node 24.19+:

```bash
git clone https://github.com/Pepebits/share-stories && cd share-stories
pnpm install && pnpm run login
```

Copy the resulting `data/telegram-session.txt` into the `data/` directory this
container mounts (mode `0600`, owned by uid `1000` — the container's non-root
user).

> That file is an **unscoped credential for the whole Telegram account** — it
> can read every private message and send as you. Keep it out of images, out
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

`GET /health` returns `200 ok` while Telegram is connected and `503` once the
session drops, so the container goes unhealthy instead of idling. It discloses
nothing about what is hosted.

## Instagram setup

Getting `INSTAGRAM_ACCOUNT_ID` and `INSTAGRAM_ACCESS_TOKEN` out of Meta's
console is the fiddliest part, and its documentation contradicts its own
dashboard in places. Step by step:
[docs/INSTAGRAM_SETUP.md](https://github.com/Pepebits/share-stories/blob/main/docs/INSTAGRAM_SETUP.md)

## Tags

| Tag | Meaning |
|---|---|
| `1.1.0` | Exact version, never moves |
| `1.1` | Newest patch of that minor series |
| `latest` | Newest release |

Pin `1.1.0` if you want reproducibility; use `1.1` to pick up patches.

## Licence

MIT
