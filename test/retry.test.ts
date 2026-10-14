import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/utils/retry.js';
import type { Logger } from '../src/utils/logger.js';

type Entry = { level: string; message: string; meta?: unknown };

function recordingLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  const record =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      entries.push({ level, message, meta });
    };
  const logger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  } as unknown as Logger;
  return { logger, entries };
}

const options = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, operation: 'op' };

describe('withRetry logging', () => {
  it('keeps upstream error text out of the retry message, in metadata', async () => {
    const { logger, entries } = recordingLogger();
    const hostile = 'boom\nINFO fake line\r\nERROR another';

    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error(hostile)) : Promise.resolve('ok');
      },
      { ...options, logger }
    );

    assert.equal(result, 'ok');
    const warn = entries.find((entry) => entry.level === 'warn');
    assert.ok(warn);
    assert.doesNotMatch(warn.message, /[\r\n]/);
    assert.ok(!warn.message.includes('boom'));
    assert.match(warn.message, /attempt 1\/2 failed, retrying in/);
    assert.deepEqual(warn.meta, { error: hostile });
  });

  it('keeps upstream error text out of the give-up message too', async () => {
    const { logger, entries } = recordingLogger();
    await assert.rejects(() =>
      withRetry(() => Promise.reject(new Error('bad\ntoken')), {
        ...options,
        logger,
        shouldRetry: () => false,
      })
    );

    const debug = entries.find((entry) => entry.level === 'debug');
    assert.ok(debug);
    assert.doesNotMatch(debug.message, /[\r\n]|bad/);
    assert.deepEqual(debug.meta, { error: 'bad\ntoken' });
  });

  it('still reports the final failure to the caller', async () => {
    await assert.rejects(
      () => withRetry(() => Promise.reject(new Error('nope')), options),
      /all 2 attempts failed: nope/
    );
  });
});
