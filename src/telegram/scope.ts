/**
 * Who a Telegram story was meant for. Instagram's Content Publishing API has
 * no audience parameter — a story always goes to every follower, so a
 * close-friends story can only be honoured by declining to republish it.
 *
 * The default carries everything; narrowing via TELEGRAM_STORY_SCOPES is
 * opt-in, and worth doing whenever the monitored peers are other people.
 */

export type StoryScope = 'public' | 'contacts' | 'selectedContacts' | 'closeFriends' | 'unknown';

export const ALL_SCOPES: StoryScope[] = [
  'public',
  'contacts',
  'selectedContacts',
  'closeFriends',
];

/**
 * Everything, matching what this bridge did before it read scopes at all —
 * meaning a monitored peer's close-friends stories reach every follower.
 * Set TELEGRAM_STORY_SCOPES=public to carry only what was already open.
 */
export const DEFAULT_ALLOWED_SCOPES: StoryScope[] = ALL_SCOPES;

interface ScopeFlags {
  public?: boolean;
  closeFriends?: boolean;
  contacts?: boolean;
  selectedContacts?: boolean;
}

/**
 * The narrowest audience the flags describe, checked most-restrictive first:
 * Telegram can set `contacts` alongside `closeFriends`, and reading the wider
 * of the two would be exactly the mistake this exists to prevent. A story
 * with no flags at all is 'unknown', and not republished by default.
 */
export function storyScope(story: ScopeFlags): StoryScope {
  if (story.closeFriends) return 'closeFriends';
  if (story.selectedContacts) return 'selectedContacts';
  if (story.contacts) return 'contacts';
  if (story.public) return 'public';
  return 'unknown';
}

/**
 * Fallback when a configured value can't be read. Deliberately not
 * DEFAULT_ALLOWED_SCOPES: a typo must not hand someone the opposite of the
 * restriction they were reaching for.
 */
const SAFEST_SCOPES: StoryScope[] = ['public'];

/**
 * Reads the configured list. Absent or empty means the default; anything
 * unreadable falls back to public only — carrying too little loses a repost,
 * but carrying too much shows someone's private story to strangers.
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

  return parsed.length > 0 ? parsed : SAFEST_SCOPES;
}

/**
 * Whether a story's audience is one the operator agreed to republish. An
 * 'unknown' audience is carried only when every known scope is allowed — an
 * audience we cannot read is not one we can claim to have been permitted.
 */
export function isAllowed(scope: StoryScope, allowed: StoryScope[]): boolean {
  if (scope !== 'unknown') return allowed.includes(scope);
  return ALL_SCOPES.every((known) => allowed.includes(known));
}
