# Deployment

Meta does not accept file uploads. It fetches story media over HTTP from a URL
you serve, which means this process must be reachable from the public internet
on HTTPS. That single requirement shapes everything below.

```
   Telegram ──▶ bridge ──▶ media server :8080 ──▶ Cloudflare tunnel ──▶ Meta
                                                   (public HTTPS)
```

The media server hands out single-use, 256-bit URLs that are revoked the moment
Meta has fetched them. It still must never be exposed directly — put the tunnel
in front of it and keep the port off the host.

---

## Requirements

| | |
|---|---|
| Node.js | 22+ (only for running without Docker) |
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

## Production with Docker

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
docker compose up -d --build
docker compose logs -f bridge
```

### Notes on the compose file

- **Port 8080 is not published to the host.** It is on the internal network
  only, reachable by the tunnel. Publishing it would expose story media.
- `MEDIA_SERVER_HOST` is forced to `0.0.0.0`: the default loopback bind is
  unreachable from a different container.
- `./data` is a bind mount and holds the Telegram session, the rotating
  Instagram token and the dedupe database. **Back it up.** Losing it means
  re-authenticating and re-posting every story still active.

---

## Production without Docker (systemd)

`share-historys.service` is included and already hardened: dedicated user,
`ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges`.

```bash
sudo useradd -r -s /bin/false share-historys
sudo cp -r dist node_modules package.json .env /opt/share-historys/
sudo chown -R share-historys:share-historys /opt/share-historys
sudo cp share-historys.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now share-historys
```

You still need a public HTTPS origin in front of `MEDIA_SERVER_PORT` — either
cloudflared as a service, or nginx/Caddy terminating TLS.

---

## Operating it

**Logs.** Everything goes to stdout (`docker compose logs`, `journalctl -u
share-historys`). Nothing else reports failures: if the bridge stops
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
