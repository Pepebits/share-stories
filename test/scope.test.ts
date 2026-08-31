import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  storyScope,
  parseScopes,
  isAllowed,
  ALL_SCOPES,
  DEFAULT_ALLOWED_SCOPES,
} from '../src/telegram/scope.js';

/**
 * Instagram publishes to every follower and offers no way to narrow it, so
 * misreading a Telegram audience does not produce a wrong log line — it shows
 * a close-friends story to everyone.
 */
describe('storyScope', () => {
  it('reads a public story', () => {
    assert.equal(storyScope({ public: true }), 'public');
  });

  it('reads a close friends story', () => {
    assert.equal(storyScope({ closeFriends: true }), 'closeFriends');
  });

  it('reads a contacts-only story', () => {
    assert.equal(storyScope({ contacts: true }), 'contacts');
  });

  it('reads a selected-contacts story', () => {
    assert.equal(storyScope({ selectedContacts: true }), 'selectedContacts');
  });

  // Telegram can set several flags at once, and reading the wider one is the
  // whole failure mode this guards against.
  it('takes the narrowest audience when flags overlap', () => {
    assert.equal(storyScope({ contacts: true, closeFriends: true }), 'closeFriends');
    assert.equal(storyScope({ public: true, closeFriends: true }), 'closeFriends');
    assert.equal(storyScope({ public: true, contacts: true }), 'contacts');
    assert.equal(
      storyScope({ contacts: true, selectedContacts: true, public: true }),
      'selectedContacts'
    );
  });

  it('calls a story with no flags unknown rather than public', () => {
    assert.equal(storyScope({}), 'unknown');
  });
});

describe('isAllowed', () => {
  it('carries a scope that was asked for', () => {
    assert.equal(isAllowed('public', ['public']), true);
    assert.equal(isAllowed('closeFriends', ALL_SCOPES), true);
  });

  it('refuses a scope that was not', () => {
    assert.equal(isAllowed('closeFriends', ['public']), false);
    assert.equal(isAllowed('contacts', ['public', 'selectedContacts']), false);
  });

  // "Everything" includes the audiences we could not name; anything narrower
  // cannot claim an unreadable audience was permitted.
  it('carries an unknown audience only when everything is allowed', () => {
    assert.equal(isAllowed('unknown', ALL_SCOPES), true);
    assert.equal(isAllowed('unknown', DEFAULT_ALLOWED_SCOPES), true);
    assert.equal(isAllowed('unknown', ['public']), false);
    assert.equal(isAllowed('unknown', ['public', 'contacts', 'selectedContacts']), false);
  });
});

describe('parseScopes', () => {
  // Matches what the bridge did before it read scopes at all.
  it('carries everything when nothing is configured', () => {
    assert.deepEqual(parseScopes(undefined), ALL_SCOPES);
    assert.deepEqual(parseScopes(''), ALL_SCOPES);
    assert.deepEqual(parseScopes('   '), ALL_SCOPES);
  });

  it('reads a list', () => {
    assert.deepEqual(parseScopes('public,contacts'), ['public', 'contacts']);
  });

  it('tolerates spacing and casing', () => {
    assert.deepEqual(parseScopes(' Public , CLOSEFRIENDS '), ['public', 'closeFriends']);
  });

  it('accepts close_friends and close-friends alike', () => {
    assert.deepEqual(parseScopes('close_friends'), ['closeFriends']);
    assert.deepEqual(parseScopes('close-friends'), ['closeFriends']);
  });

  it('opens everything only when asked in so many words', () => {
    assert.deepEqual(parseScopes('all'), ALL_SCOPES);
  });

  // Someone setting this variable is trying to restrict something. Falling
  // back to the permissive default would hand a typo the opposite of what it
  // was reaching for, so an unreadable value narrows instead of widening.
  it('narrows to public rather than trusting a value it cannot read', () => {
    assert.deepEqual(parseScopes('everyone'), ['public']);
    assert.deepEqual(parseScopes('pubic'), ['public']);
    assert.notDeepEqual(parseScopes('pubic'), DEFAULT_ALLOWED_SCOPES);
  });

  it('keeps the readable half of a partly mistyped list', () => {
    assert.deepEqual(parseScopes('public,nonsense'), ['public']);
  });
});
