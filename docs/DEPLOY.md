# Deployment

Meta does not accept file uploads. It fetches story media over HTTP from a URL
you serve, which means this process must be reachable from the public internet
on HTTPS. That single requirement shapes everything below.

```
   Telegram ──▶ bridge ──▶ media server :8080 ──▶ tunnel or reverse proxy ──▶ Meta
                                                        (public HTTPS)
```

The media server hands out single-use, 256-bit URLs that are revoked the moment
Meta has fetched them. It still must never face the internet directly: put a
Cloudflare tunnel or your own proxy in front, and keep the port itself private.

---

## Requirements

| | |
|---|---|
| Node.js | **24.19+** — SQLite is built in from that version, so there is no native module to compile |
| Instagram | Business or Creator account + a Meta app — see [INSTAGRAM_SETUP.md](INSTAGRAM_SETUP.md) |
| Telegram | `api_id` / `api_hash` from [my.telegram.org](https://my.telegram.org/apps), and the account's phone |
| Public HTTPS | A Cloudflare tunnel, or any reverse proxy with a real certificate |

---

## Local, for trying it out

A quick tunnel needs no Cloudflare account. Its hostname changes on every
restart, which is fine for testing and useless for production.

**1. Install and configure**

```bash
pnpm install
cp .env.example .env      # fill in the Instagram and Telegram values
pnpm run build
```

**2. Authenticate with Telegram — once, by hand**

```bash
pnpm run login
```

Telegram sends a code to your other devices; the 2FA password is asked for
separately and echoes as asterisks. This needs a real terminal: with no TTY it
refuses immediately rather than hanging. The session lands in
`data/telegram-session.txt` (mode `0600`) — copy it into
`TELEGRAM_SESSION_STRING` and delete the file.

**3. Find out what to monitor**

```bash
pnpm run inspect
```

Lists the peers with active stories and how to address them. A peer can be
named by any of its usernames, by title, or by numeric id — private channels
have nothing else. Put the answer in `TELEGRAM_MONITORED_PEERS`.

**4. Open a tunnel**

```bash
cloudflared tunnel --url http://localhost:8080
```

Copy the `https://….trycloudflare.com` line into `PUBLIC_BASE_URL`.

> If you already run a named tunnel on this machine, pass
> `--config /dev/null` (or an empty file). Otherwise cloudflared inherits
> `~/.cloudflared/config.yml`, registers against *that* tunnel, and the quick
> hostname resolves to whatever catch-all rule the config ends with — usually a
> flat 404 that looks like a broken tunnel.

**5. Run it**

```bash
pnpm start
```

---

## How the public URL reaches the bridge

The bridge never discovers its own hostname. You tell it, through one variable:

```bash
PUBLIC_BASE_URL=https://stories.example.com
```

That is the address it stamps into the URLs it hands Meta, so it must be the
address **Meta** resolves — the proxy or tunnel in front, never the container's
own port. Startup refuses a loopback or private address rather than letting
every publish fail with an opaque container `ERROR`.

Two ways to provide it, both supported by the same compose file:

| | Command | When |
|---|---|---|
| Cloudflare tunnel | `docker compose --profile tunnel up -d` | No public IP, no certificate to manage |
| Your own proxy | `docker compose up -d` | You already run Caddy, nginx or Traefik |

### With your own reverse proxy

The bridge publishes `8080` on **loopback only** by default, so a proxy on the
same host can reach it and the internet cannot. Adjust with `BRIDGE_PORT`, or
`BRIDGE_BIND` if the proxy lives elsewhere.

Caddy needs two lines:

```caddyfile
stories.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx, equivalently:

```nginx
server {
    server_name stories.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

Then set `PUBLIC_BASE_URL=https://stories.example.com` and start with plain
`docker compose up -d` — the tunnel container stays out of it.

> **Do not expose port 8080 itself.** It serves story media at unauthenticated
> URLs. They are single-use and revoked as soon as Meta fetches them, but the
> port belongs behind TLS either way.

If your proxy runs in Docker too, drop the `ports:` block and put both on the
same network instead; the proxy then reaches the bridge as `bridge:8080`.

### Health endpoint

`GET /health` returns `200 ok` and discloses nothing else. Use it for proxy
health checks; the container already uses it for its own `HEALTHCHECK`.

## Production with the Cloudflare tunnel

Two containers: the bridge, and a **named** tunnel whose hostname survives
restarts.

**1. Create the tunnel**

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a
tunnel**, pick **Cloudflared**, and copy the token it shows.

Then add a **public hostname** to that tunnel:

| Field | Value |
|---|---|
| Subdomain | e.g. `stories` |
| Domain | your domain |
| Service | `http://bridge:8080` |

`bridge` is the compose service name — the containers share a network, so the
tunnel resolves it by name.

**2. Configure**

```bash
cp .env.example .env         # Instagram + Telegram credentials
```

Add the two values compose needs:

```bash
PUBLIC_BASE_URL=https://stories.example.com
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
```

**3. Authenticate before the first start**

The login prompt cannot work inside a detached container. Run `pnpm run login`
on any machine with Node, then put the resulting string in
`TELEGRAM_SESSION_STRING` — or drop the file into `./data`, which is mounted
into the container.

**4. Start**

```bash
docker compose --profile tunnel up -d --build
docker compose logs -f bridge
```

With this profile the bridge does not need its port on the host at all — the
tunnel reaches it over the internal network as `bridge:8080`.

### Notes on the compose file

- **Port 8080 is published to loopback only** (`127.0.0.1:8080`), so a proxy on
  the same host can reach it and the internet cannot. Change it with
  `BRIDGE_PORT` / `BRIDGE_BIND`, or delete the block when using the tunnel.
- `MEDIA_SERVER_HOST` is forced to `0.0.0.0`: the default loopback bind is
  unreachable from a different container.
- The container runs **read-only**, as a non-root user, with all capabilities
  dropped. Only the mounted `./data` is writable.
- `./data` is a bind mount and holds the Telegram session, the rotating
  Instagram token and the dedupe database. **Back it up.** Losing it means
  re-authenticating and re-posting every story still active.

---

## Publishing the image

Tagging a release builds and pushes to GitHub Container Registry:

```bash
git tag v1.0.0
git push --tags
```

`.github/workflows/publish.yml` publishes `ghcr.io/<owner>/share-stories` as
`1.0.0`, `1.0` and `latest`.

> **It builds for amd64 and arm64.** An image built only on an Apple Silicon
> machine will not start on an x86 server, and the failure — `exec format
> error` — says nothing useful. The arm64 half is emulated on an x64 runner, so
> the job takes a while.

### Pulling it

The package inherits the repository's visibility. While the repo is private,
anyone pulling needs to authenticate:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin
docker pull ghcr.io/pepebits/share-stories:latest
```

The token needs `read:packages`. To let someone pull without one, make the
package public: **Packages → share-stories → Package settings → Change
visibility**. The image contains no credentials — `.env` and `data/` are
excluded by `.dockerignore` — but it does disclose the source layout.

Then point compose at the published image instead of building:

```yaml
services:
  bridge:
    image: ghcr.io/pepebits/share-stories:latest
    # build: .        ← remove or comment out
```

### Publishing by hand

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/pepebits/share-stories:latest \
  --push .
```

`docker build` alone produces a single-architecture image; `buildx` with
`--platform` is what makes it portable.

---

## Production without Docker (systemd)

`share-stories.service` is included and already hardened: dedicated user,
`ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges`.

```bash
sudo useradd -r -s /bin/false share-stories
sudo cp -r dist node_modules package.json .env /opt/share-stories/
sudo chown -R share-stories:share-stories /opt/share-stories
sudo cp share-stories.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now share-stories
```

You still need a public HTTPS origin in front of `MEDIA_SERVER_PORT` — either
cloudflared as a service, or nginx/Caddy terminating TLS.

---

## Operating it

**Logs.** Everything goes to stdout (`docker compose logs`, `journalctl -u
share-stories`). Nothing else reports failures: if the bridge stops
publishing, only the log will say so.

**Backups.** `./data` is the only stateful thing. Both credential files are
mode `0600`.

**Updating.**

```bash
git pull
docker compose up -d --build      # or: pnpm install && pnpm run build && restart
```

**Quota.** 100 publishes per rolling 24h, and stories count. The bridge checks
before each publish and pauses when exhausted rather than failing the story.
`INSTAGRAM_QUOTA_RESERVE` holds some back for posting by hand.

## When it stops working

| Symptom | Cause |
|---|---|
| Container ends `ERROR` on every publish | `PUBLIC_BASE_URL` is not reachable from the internet. Fetch it from another network to check. |
| `Instagram credentials rejected` at startup | Token expired or revoked — see [INSTAGRAM_SETUP.md](INSTAGRAM_SETUP.md). |
| Prompts for a login code on every start | `TELEGRAM_SESSION_STRING` is not being persisted, or `./data` is not mounted. |
| Nothing is bridged, no errors | `TELEGRAM_MONITORED_PEERS` matches nothing. Run `pnpm run inspect`. |
| A story was never published and never retried | Fixed: interrupted stories are recovered at startup. Older versions could leave one stuck. |
