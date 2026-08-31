/**
 * Who a Telegram story was meant for.
 *
 * Worth understanding before changing anything here. Instagram's Content
 * Publishing API has no audience parameter at all — a story published through
 * it always goes to every follower. So a Telegram story meant for close
 * friends does not arrive on Instagram as a close-friends story; it arrives as
 * a public one. The restriction cannot be carried across, only honoured by
 * declining to republish the story.
 *
 * The default below carries everything, which is what this bridge did before
 * scopes were read at all. Narrowing it is opt-in through
 * TELEGRAM_STORY_SCOPES, and worth doing whenever the monitored peers are
 * other people: their close-friends stories are not yours to widen.
 */

export type StoryScope = 'public' | 'contacts' | 'selectedContacts' | 'closeFriends' | 'unknown';

export const ALL_SCOPES: StoryScope[] = [
  'public',
  'contacts',
  'selectedContacts',
  'closeFriends',
];

/**
 * Everything, matching what this bridge did before it read scopes at all.
 *
 * Note what this means: a close-friends story from a monitored peer is
 * republished where all your Instagram followers can see it. Set
 * TELEGRAM_STORY_SCOPES=public to carry only what was already open.
 */
export const DEFAULT_ALLOWED_SCOPES: StoryScope[] = ALL_SCOPES;

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
 * The narrowest useful setting, used when a configured value cannot be read.
 *
 * Deliberately not DEFAULT_ALLOWED_SCOPES: someone who sets this variable is
 * trying to restrict something, and a typo must not hand them the opposite of
 * what they were reaching for.
 */
const SAFEST_SCOPES: StoryScope[] = ['public'];

/**
 * Reads the configured list. Absent or empty means the default; anything
 * unreadable falls back to public only, because the two mistakes are not
 * equally bad — carrying too little loses a repost, carrying too much shows
 * someone's private story to strangers.
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
 * Whether a story's audience is one the operator agreed to republish.
 *
 * A story whose flags say nothing is 'unknown', and is carried only when every
 * known scope is allowed — if the setting is "everything", an unrecognised
 * audience is still everything; if it is narrower, an audience we cannot read
 * is not one we can claim to have been permitted.
 */
export function isAllowed(scope: StoryScope, allowed: StoryScope[]): boolean {
  if (scope !== 'unknown') return allowed.includes(scope);
  return ALL_SCOPES.every((known) => allowed.includes(known));
}
