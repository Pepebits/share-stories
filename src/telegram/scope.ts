/**
 * Who a Telegram story was meant for.
 *
 * This matters more here than it looks. Instagram's Content Publishing API has
 * no audience parameter at all — a story published through it always goes to
 * every follower. So a Telegram story meant for close friends does not arrive
 * on Instagram as a close-friends story; it arrives as a public one. There is
 * no way to carry the restriction across, which leaves refusing to carry the
 * story as the only honest option.
 *
 * Hence the default below: republish what was already public, and nothing
 * else, unless someone says otherwise in so many words.
 */

export type StoryScope = 'public' | 'contacts' | 'selectedContacts' | 'closeFriends' | 'unknown';

export const ALL_SCOPES: StoryScope[] = [
  'public',
  'contacts',
  'selectedContacts',
  'closeFriends',
];

/** Only what the author had already shown to everyone. */
export const DEFAULT_ALLOWED_SCOPES: StoryScope[] = ['public'];

interface ScopeFlags {
  public?: boolean;
  closeFriends?: boolean;
  contacts?: boolean;
  selectedContacts?: boolean;
}

/**
 * The narrowest audience the flags describe.
 *
 * Checked most-restrictive first: Telegram can set `contacts` alongside
 * `closeFriends`, and reading the wider of the two would be exactly the
 * mistake this exists to prevent. A story with no flags at all is 'unknown'
 * and, being unrecognised rather than known-public, is not republished by
 * default.
 */
export function storyScope(story: ScopeFlags): StoryScope {
  if (story.closeFriends) return 'closeFriends';
  if (story.selectedContacts) return 'selectedContacts';
  if (story.contacts) return 'contacts';
  if (story.public) return 'public';
  return 'unknown';
}

/**
 * Reads the configured list. An empty or absent setting means the default;
 * 'all' is spelled out rather than inferred, so widening the audience is
 * always something someone typed on purpose.
 */
export function parseScopes(raw: string | undefined): StoryScope[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) return DEFAULT_ALLOWED_SCOPES;
  if (entries.some((entry) => entry.toLowerCase() === 'all')) return ALL_SCOPES;

  const known = new Map(ALL_SCOPES.map((scope) => [scope.toLowerCase(), scope]));
  const parsed = entries.flatMap((entry) => {
    const match = known.get(entry.toLowerCase().replace(/[_-]/g, ''));
    return match ? [match] : [];
  });

  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_SCOPES;
}
