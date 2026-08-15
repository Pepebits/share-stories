import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInteractive, NonInteractiveError, prompt } from '../src/utils/prompt.js';

/**
 * The property that matters in production: under systemd there is no terminal,
 * and a prompt that waits on stdin would hang the service forever instead of
 * reporting that it needs a session string.
 */
describe('prompt', () => {
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdin.isTTY = stdinTTY;
    process.stdout.isTTY = stdoutTTY;
  });

  it('reports non-interactive when stdin is not a TTY', () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;
    assert.equal(isInteractive(), false);
  });

  it('reports non-interactive when stdout is redirected', () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;
    assert.equal(isInteractive(), false);
  });

  it('rejects instead of hanging when there is no terminal', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await assert.rejects(
      () => prompt('Telegram login code: '),
      (error: Error) => {
        assert.ok(error instanceof NonInteractiveError);
        assert.match(error.message, /TELEGRAM_SESSION_STRING/);
        return true;
      }
    );
  });

  it('names the thing it could not ask for', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await assert.rejects(
      () => prompt('Telegram 2FA password: ', true),
      /Telegram 2FA password/
    );
  });
});
