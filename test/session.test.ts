import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, resolveSession, writeSession } from '../src/telegram/session.js';

describe('telegram session file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an empty string when there is no file yet', () => {
    assert.equal(readSession(join(dir, 'missing.txt')), '');
  });

  it('propagates errors other than ENOENT', () => {
    assert.throws(() => readSession(dir));
  });

  it('writes and reads back the same session', () => {
    const path = join(dir, 'sub', 'telegram-session.txt');
    writeSession(path, '  abc123  ');
    assert.equal(readSession(path), 'abc123');
  });

  it('writes the file owner-readable only', async () => {
    const path = join(dir, 'telegram-session.txt');
    writeSession(path, 'abc123');
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
  });

  it('leaves no temp file behind', async () => {
    const path = join(dir, 'telegram-session.txt');
    writeSession(path, 'abc123');
    assert.deepEqual(await readdir(dir), ['telegram-session.txt']);
  });

  it('creates the directory if it does not exist', () => {
    const path = join(dir, 'nested', 'deeper', 'telegram-session.txt');
    writeSession(path, 'abc123');
    assert.equal(readSession(path), 'abc123');
  });

  describe('resolveSession', () => {
    it('prefers the file over the environment, since only the file follows rotation', () => {
      const path = join(dir, 'telegram-session.txt');
      writeSession(path, 'rotated');
      assert.deepEqual(resolveSession(path, 'stale-env'), { session: 'rotated', source: 'file' });
    });

    it('falls back to the environment when there is no file yet', () => {
      const path = join(dir, 'telegram-session.txt');
      assert.deepEqual(resolveSession(path, ' seed '), { session: 'seed', source: 'env' });
    });

    it('reports nothing when neither is set', () => {
      const path = join(dir, 'telegram-session.txt');
      assert.deepEqual(resolveSession(path, undefined), { session: '', source: 'none' });
      assert.deepEqual(resolveSession(path, ''), { session: '', source: 'none' });
    });
  });
});
