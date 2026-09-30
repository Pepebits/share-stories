import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthKeyUnregisteredError,
  AuthKeyDuplicatedError,
  SessionPasswordNeededError,
  SessionRevokedError,
  UserDeactivatedBanError,
  UserDeactivatedError,
  FloodError,
} from 'teleproto/errors';
import { Api } from 'teleproto';
import { asSessionError } from '../src/telegram/auth-errors.js';
import { TelegramSessionError, sessionLostError } from '../src/telegram/session-error.js';

const request = { className: 'users.GetUsers' };

/** Typed RPC errors are what a revoked session looks like on the wire; anything else is not one. */
describe('asSessionError', () => {
  it('maps each lost-session RPC error to a TelegramSessionError carrying the login hint', () => {
    const lost = [
      new SessionRevokedError({ request }),
      new AuthKeyUnregisteredError({ request }),
      new AuthKeyDuplicatedError({ request }),
      new UserDeactivatedError({ request }),
      new UserDeactivatedBanError({ request }),
    ];

    for (const error of lost) {
      const mapped = asSessionError(error);
      assert.ok(mapped instanceof TelegramSessionError, error.constructor.name);
      assert.match(mapped.message, /pnpm run login/);
    }
  });

  it("includes Telegram's own reason in the message", () => {
    const mapped = asSessionError(new SessionRevokedError({ request }));
    assert.match(mapped?.message ?? '', /SESSION_REVOKED/);
  });

  it('leaves a password prompt alone: it is a login step, not a lost session', () => {
    assert.equal(asSessionError(new SessionPasswordNeededError({ request })), null);
  });

  it('leaves network and unrelated RPC errors alone', () => {
    assert.equal(asSessionError(new Error('ETIMEDOUT')), null);
    assert.equal(
      asSessionError(new FloodError('FLOOD_WAIT_5', new Api.users.GetUsers({ id: [] }))),
      null
    );
    assert.equal(asSessionError('SESSION_REVOKED'), null);
  });

  it('passes an existing TelegramSessionError through unchanged', () => {
    const error = sessionLostError();
    assert.equal(asSessionError(error), error);
  });
});
