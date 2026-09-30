/**
 * Shows what the authenticated account can actually see, so TELEGRAM_MONITORED_PEERS
 * can be filled in from evidence rather than guesswork. Read-only: publishes nothing,
 * downloads no media.
 *
 *   pnpm run inspect
 */
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { LogLevel } from 'teleproto/extensions/Logger.js';
import { resolve } from 'node:path';
import { loadDotEnv } from '../src/utils/env.js';
import { namesOf, peerLabel, type RawPeer } from '../src/telegram/feed.js';
import { resolveSession } from '../src/telegram/session.js';

loadDotEnv();

/** A peer is a user, a channel or a basic group; exactly one of these ids is set. */
const peerIdOf = (peer: Api.TypePeer): string =>
  String('userId' in peer ? peer.userId : 'channelId' in peer ? peer.channelId : peer.chatId);

const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
const sessionFile = resolve(process.env.TELEGRAM_SESSION_FILE ?? './data/telegram-session.txt');
const { session: sessionString } = resolveSession(sessionFile, process.env.TELEGRAM_SESSION_STRING);

if (!apiId || !apiHash) {
  console.error('Needs TELEGRAM_API_ID and TELEGRAM_API_HASH in .env');
  process.exit(1);
}
if (!sessionString) {
  console.error(`No Telegram session at ${sessionFile}. Run \`pnpm run login\` first.`);
  process.exit(1);
}

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 3,
});

// The library logs every connection step at info level; only errors matter here.
client.setLogLevel(LogLevel.ERROR);
await client.connect();

const me = await client.getMe();
const myHandles = namesOf(me).handles;
console.log(
  `\nAuthenticated as ${myHandles.length ? myHandles.map((h) => '@' + h).join(', ') : (me.firstName ?? '?')}` +
    ` — id ${String(me.id)}\n`
);

console.log('── stories.GetAllStories ───────────────────────────────');
const all = await client.invoke(new Api.stories.GetAllStories({}));

// AllStoriesNotModified has no feed; with no state token sent it should not occur.
const feed = 'peerStories' in all ? all.peerStories : [];
if (feed.length === 0) {
  console.log('  (empty — nobody you follow has an active story right now)');
} else {
  const known: RawPeer[] = 'users' in all ? [...all.users, ...all.chats] : [];
  for (const entry of feed) {
    const id = peerIdOf(entry.peer);
    const user = known.find((u) => String(u.id) === id);
    console.log(`  ${peerLabel(id, user && namesOf(user))} — ${entry.stories.length} story(ies)`);
  }
}

console.log('\n── stories.GetPeerStories (self) ───────────────────────');
try {
  const mine = await client.invoke(new Api.stories.GetPeerStories({ peer: 'me' }));

  const count = mine.stories.stories.length;
  console.log(
    count === 0
      ? '  (none active — post a story and run this again)'
      : `  ${count} active story(ies) of your own`
  );

  const selfInFeed = feed.some(
    (entry) => 'userId' in entry.peer && String(entry.peer.userId) === String(me.id)
  );
  console.log(`\n  Own stories appear in GetAllStories: ${selfInFeed ? 'YES' : 'NO'}`);
} catch (error) {
  console.log('  failed:', error instanceof Error ? error.message : error);
}

await client.disconnect();
process.exit(0);
