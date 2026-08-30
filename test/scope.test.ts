import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  storyScope,
  parseScopes,
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
    assert.ok(
      !DEFAULT_ALLOWED_SCOPES.includes('unknown'),
      'and unknown must not be republished by default'
    );
  });
});

describe('parseScopes', () => {
  it('defaults to public only', () => {
    assert.deepEqual(parseScopes(undefined), ['public']);
    assert.deepEqual(parseScopes(''), ['public']);
    assert.deepEqual(parseScopes('   '), ['public']);
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

  // A typo must not silently widen the audience.
  it('falls back to the default rather than trusting a value it cannot read', () => {
    assert.deepEqual(parseScopes('everyone'), ['public']);
    assert.deepEqual(parseScopes('pubic'), ['public']);
  });

  it('keeps the readable half of a partly mistyped list', () => {
    assert.deepEqual(parseScopes('public,nonsense'), ['public']);
  });
});
