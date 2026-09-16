import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isInteractive, NonInteractiveError, prompt, type PromptIO } from '../src/utils/prompt.js';

/**
 * The masked branch once relied on a private readline hook that readline/promises lacks,
 * and GramJS retries a failed 2FA prompt in a loop — so it must work without one.
 */

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];
  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModeCalls.push(value);
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  setEncoding() {
    return this;
  }
  type(text: string) {
    this.emit('data', text);
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  written = '';
  write(chunk: string) {
    this.written += chunk;
    return true;
  }
}

const makeIO = () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  return { io: { input, output } as unknown as PromptIO, input, output };
};

describe('prompt', () => {
  describe('without a terminal', () => {
    const headless = {
      input: { isTTY: false },
      output: { isTTY: false },
    } as unknown as PromptIO;

    it('reports non-interactive', () => {
      assert.equal(isInteractive(headless), false);
    });

    it('rejects instead of hanging', async () => {
      await assert.rejects(
        () => prompt('Telegram login code: ', false, headless),
        (error: Error) => {
          assert.ok(error instanceof NonInteractiveError);
          assert.match(error.message, /pnpm run login/);
          return true;
        }
      );
    });

    it('names the thing it could not ask for', async () => {
      await assert.rejects(
        () => prompt('Telegram 2FA password: ', true, headless),
        /Telegram 2FA password/
      );
    });
  });

  describe('masked input', () => {
    it('returns what was typed', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('hunter2');
      input.type('\r');

      assert.equal(await answer, 'hunter2');
    });

    it('never echoes the characters', async () => {
      const { io, input, output } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('secret');
      input.type('\r');
      await answer;

      assert.equal(output.written.includes('secret'), false, 'the password leaked to the terminal');
      assert.equal(output.written, 'Password: ******\n');
    });

    it('handles backspace', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('abcX');
      input.type('');
      input.type('d');
      input.type('\r');

      assert.equal(await answer, 'abcd');
    });

    it('ignores stray control characters', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('ab');
      input.type('\r');

      assert.equal(await answer, 'ab');
    });

    it('accepts input arriving in one chunk', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('all-at-once\n');

      assert.equal(await answer, 'all-at-once');
    });

    it('honours Ctrl-C, which raw mode would otherwise swallow', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('');

      await assert.rejects(() => answer, /Cancelled/);
    });

    it('restores the terminal afterwards', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('x\r');
      await answer;

      assert.deepEqual(input.rawModeCalls, [true, false]);
      assert.equal(input.isRaw, false);
    });

    it('restores the terminal even when cancelled', async () => {
      const { io, input } = makeIO();
      const answer = prompt('Password: ', true, io);

      input.type('');
      await answer.catch(() => {});

      assert.equal(input.isRaw, false);
    });
  });
});
