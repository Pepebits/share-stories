import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../src/utils/env.js';

describe('loadDotEnv', { skip: process.platform === 'win32' }, () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'env-'));
    path = join(dir, '.env');
    delete process.env.ENV_TEST_VALUE;
  });

  afterEach(async () => {
    mock.restoreAll();
    delete process.env.ENV_TEST_VALUE;
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when there is no file', () => {
    const warn = mock.method(console, 'error', () => {});
    loadDotEnv(join(dir, 'missing.env'));
    assert.equal(warn.mock.callCount(), 0);
  });

  it('loads the file and stays quiet when it is owner-only', async () => {
    await writeFile(path, 'ENV_TEST_VALUE=ok\n', { mode: 0o600 });
    await chmod(path, 0o600);
    const warn = mock.method(console, 'error', () => {});
    loadDotEnv(path);
    assert.equal(process.env.ENV_TEST_VALUE, 'ok');
    assert.equal(warn.mock.callCount(), 0);
  });

  it('still loads a group- or world-readable file, but warns naming it and chmod 600', async () => {
    await writeFile(path, 'ENV_TEST_VALUE=ok\n');
    await chmod(path, 0o644);
    const warn = mock.method(console, 'error', () => {});
    loadDotEnv(path);
    assert.equal(process.env.ENV_TEST_VALUE, 'ok');
    assert.equal(warn.mock.callCount(), 1);
    const message = String(warn.mock.calls[0]?.arguments[0]);
    assert.ok(message.includes(path));
    assert.ok(message.includes('chmod 600'));
  });

  it('warns for a group-readable file too', async () => {
    await writeFile(path, 'ENV_TEST_VALUE=ok\n');
    await chmod(path, 0o640);
    const warn = mock.method(console, 'error', () => {});
    loadDotEnv(path);
    assert.equal(warn.mock.callCount(), 1);
  });
});
