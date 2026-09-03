/**
 * Shows what the authenticated account can actually see, so TELEGRAM_MONITORED_PEERS
 * can be filled in from evidence rather than guesswork. Read-only: publishes nothing,
 * downloads no media.
 *
 *   pnpm run inspect
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { loadDotEnv } from '../src/utils/env.js';
import { namesOf, peerLabel, type RawPeer } from '../src/telegram/feed.js';

loadDotEnv();

const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
const sessionString = process.env.TELEGRAM_SESSION_STRING ?? '';

if (!apiId || !apiHash || !sessionString) {
  console.error('Needs TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION_STRING in .env');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 3,
});

// The library logs every connection step at info level; only errors matter here.
client.setLogLevel('error' as never);
await client.connect();

const me = (await client.getMe()) as unknown as RawPeer;
const myHandles = namesOf(me).handles;
console.log(
  `\nAuthenticated as ${myHandles.length ? myHandles.map((h) => '@' + h).join(', ') : (me.firstName ?? '?')}` +
    ` — id ${String(me.id)}\n`
);

console.log('── stories.GetAllStories ───────────────────────────────');
const all = (await client.invoke(new Api.stories.GetAllStories({}))) as unknown as {
  peerStories?: { peer: unknown; stories: unknown[] }[];
  users?: unknown[];
  chats?: unknown[];
};

const feed = all.peerStories ?? [];
if (feed.length === 0) {
  console.log('  (empty — nobody you follow has an active story right now)');
} else {
  for (const entry of feed) {
    const peerId =
      (entry.peer as { userId?: { toString(): string }; channelId?: { toString(): string } }) ?? {};
    const id = (peerId.userId ?? peerId.channelId)?.toString() ?? '?';
    const user = [...(all.users ?? []), ...(all.chats ?? [])].find(
      (u) => String((u as { id?: unknown }).id) === id
    ) as RawPeer | undefined;
    console.log(`  ${peerLabel(id, user && namesOf(user))} — ${entry.stories.length} story(ies)`);
  }
}

console.log('\n── stories.GetPeerStories (self) ───────────────────────');
try {
  const mine = (await client.invoke(new Api.stories.GetPeerStories({ peer: 'me' }))) as unknown as {
    stories?: { stories?: unknown[] };
  };

  const count = mine.stories?.stories?.length ?? 0;
  console.log(
    count === 0
      ? '  (none active — post a story and run this again)'
      : `  ${count} active story(ies) of your own`
  );

  const selfInFeed = feed.some((entry) => {
    const p = entry.peer as { userId?: { toString(): string } };
    return (p.userId?.toString() ?? '') === String(me.id);
  });
  console.log(`\n  Own stories appear in GetAllStories: ${selfInFeed ? 'YES' : 'NO'}`);
} catch (error) {
  console.log('  failed:', error instanceof Error ? error.message : error);
}

await client.disconnect();
process.exit(0);
