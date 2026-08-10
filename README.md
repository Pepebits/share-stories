# Share Historys

Cross-platform story automation — bridge Telegram and Instagram stories in both directions.

- **Telegram → Instagram**: New stories on Telegram channels/users are automatically reposted to Instagram
- **Instagram → Telegram**: New stories on Instagram accounts are automatically reposted to Telegram

## Architecture

```
┌──────────────────┐          ┌──────────────────┐
│  Telegram Story  │   GramJS │  Instagram Story │
│   (Source)       │──────────│   (Target)       │
│                  │  Bridge  │                  │
│  Monitored via   │  TG → IG │  Posted via      │
│  GramJS MTProto  │          │  instagram-      │
│                  │          │  private-api     │
└──────────────────┘          └──────────────────┘

┌──────────────────┐          ┌──────────────────┐
│  Instagram Story │  insta-  │  Telegram Story  │
│   (Source)       │──────────│   (Target)       │
│                  │  Bridge  │                  │
│  Read via        │  IG → TG │  Posted via      │
│  UserStoryFeed   │          │  Bot API         │
│                  │          │  postStory()      │
└──────────────────┘          └──────────────────┘
```

## Tech Stack

- **Runtime**: Node.js 22+ (ESM)
- **Language**: TypeScript 5.7
- **Telegram Bot API**: `node-telegram-bot-api` v1.1.0
- **Telegram MTProto (story reading)**: GramJS (`telegram` package)
- **Instagram**: `instagram-private-api` v1.46 (primary) + Graph API (optional fallback)
- **State Store**: SQLite via `better-sqlite3`
- **Logging**: Winston

## Prerequisites

### Telegram (Bot API — for posting stories)

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Enable **Business Mode**: `/mybots` → Bot Settings → Business Mode → Enable
3. You need a **Telegram Business account** with **Telegram Premium**
4. Link the bot: Settings → Telegram Business → Chatbots → Add your bot
5. When linked, your bot receives a `business_connection` update with the `business_connection_id`
6. Grant the bot the **`can_manage_stories`** right

### Telegram (GramJS — for reading stories, TG→IG bridge only)

1. Go to [my.telegram.org](https://my.telegram.org/apps)
2. Create an app to get `api_id` and `api_hash`
3. You need a Telegram user account phone number
4. On first run, GramJS will need an authentication code (sent to your Telegram)

### Instagram

1. An Instagram account (username + password)
2. For the official Graph API (optional):
   - Facebook Developer account
   - Facebook App with `instagram_content_publish` permission
   - Instagram Business or Creator account linked to a Facebook Page

### Server

- A VPS or server running Linux with Node.js 22+
- For production: systemd or Docker

## Setup

### 1. Clone and Install

```bash
git clone <repo-url> share-historys
cd share-historys
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

See `.env.example` for all required variables. At minimum:

| Variable | Required For | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Both bridges | Bot token from @BotFather |
| `TELEGRAM_BUSINESS_CONNECTION_ID` | IG→TG bridge | From business_connection update |
| `TELEGRAM_API_ID` | TG→IG bridge | From my.telegram.org |
| `TELEGRAM_API_HASH` | TG→IG bridge | From my.telegram.org |
| `TELEGRAM_PHONE_NUMBER` | TG→IG bridge | Your phone number |
| `TELEGRAM_MONITORED_PEERS` | TG→IG bridge | Comma-separated usernames |
| `INSTAGRAM_USERNAME` | Both bridges | Instagram login |
| `INSTAGRAM_PASSWORD` | Both bridges | Instagram password |
| `INSTAGRAM_MONITORED_USERS` | IG→TG bridge | Comma-separated usernames |

### 3. Build

```bash
npm run build
```

### 4. Run (Development)

```bash
npm run dev
```

### 5. Run (Production)

```bash
npm start
```

## Deployment (VPS with systemd)

### 1. Copy files to server

```bash
scp -r dist/ package.json node_modules/ user@vps:/opt/share-historys/
scp .env user@vps:/opt/share-historys/
```

### 2. Create service user

```bash
sudo useradd -r -s /bin/false share-historys
sudo chown -R share-historys:share-historys /opt/share-historys
```

### 3. Install systemd service

```bash
sudo cp share-historys.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable share-historys
sudo systemctl start share-historys
```

### 4. Check status

```bash
sudo systemctl status share-historys
sudo journalctl -u share-historys -f
```

## Docker (Alternative)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY .env ./
RUN mkdir -p /app/data
USER node
CMD ["node", "dist/index.js"]
```

```bash
docker build -t share-historys .
docker run -d --name share-historys \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  share-historys
```

## How It Works

### Telegram → Instagram Bridge

1. GramJS connects to Telegram using your user account credentials
2. Polls for active stories via `stories.GetAllStories` MTProto API
3. Filters stories from your configured `TELEGRAM_MONITORED_PEERS`
4. Downloads story media (photo/video)
5. Checks SQLite state store to avoid duplicates
6. Posts to Instagram via `instagram-private-api` (or Graph API if configured)

### Instagram → Telegram Bridge

1. Uses `instagram-private-api` to fetch stories from configured users
2. Downloads story media at highest available resolution
3. Checks SQLite state store to avoid duplicates
4. Posts to Telegram via Bot API `postStory()` using your business connection

### State Store

- SQLite database tracking every processed story
- Prevents duplicate posts across restarts
- Records successes, failures, and error messages
- Automatic cleanup of old entries (>30 days)

## Limitations & Caveats

### Instagram
- **Unofficial API risk**: `instagram-private-api` uses Instagram's private API. Overuse may trigger action blocks or bans. Use responsibly.
- **Graph API requires public URL**: The official Instagram Graph API requires media to be hosted at a publicly accessible URL — it cannot accept direct file uploads from a buffer.
- **Rate limits**: Instagram rate-limits aggressively. The default 120s polling interval is safe for most use cases.
- **2FA**: If your Instagram account has 2FA, you may need to handle the challenge on first login.

### Telegram
- **Business account required**: Posting stories via Bot API requires Telegram Business + Premium.
- **Story reading requires MTProto**: The Bot API cannot enumerate stories. GramJS uses a user account to read them.
- **Session persistence**: GramJS sessions should be saved to `TELEGRAM_SESSION_STRING` to avoid re-authentication on each restart.

## License

MIT
