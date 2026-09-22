import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicBaseUrl, parseIntEnv, validateLogLevel } from '../src/config.js';

describe('validatePublicBaseUrl', () => {
  it('accepts a public HTTPS origin and returns it normalized', () => {
    assert.equal(
      validatePublicBaseUrl('https://stories.example.com'),
      'https://stories.example.com'
    );
  });

  it('rejects a string that is not a URL', () => {
    assert.throws(() => validatePublicBaseUrl('not a url'), /not a valid URL/);
  });

  for (const unreachable of [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://10.0.0.1',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://[::1]',
    'http://169.254.1.1',
    'http://100.64.0.1',
    'http://[fc00::1]',
    'http://[fe80::1]',
  ]) {
    it(`rejects ${unreachable}`, () => {
      assert.throws(() => validatePublicBaseUrl(unreachable), /cannot reach/);
    });
  }

  for (const reachable of [
    'http://100.63.0.1',
    'http://100.128.0.1',
    'https://fdstories.example.com',
    'https://fcbarcelona.com',
  ]) {
    it(`accepts ${reachable}`, () => {
      assert.equal(validatePublicBaseUrl(reachable), reachable);
    });
  }
});

describe('parseIntEnv', () => {
  const KEY = 'PARSE_INT_ENV_TEST_VAR';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('falls back when the variable is unset', () => {
    delete process.env[KEY];
    assert.equal(parseIntEnv(KEY, 42, 0), 42);
  });

  it('falls back when the variable is empty', () => {
    process.env[KEY] = '   ';
    assert.equal(parseIntEnv(KEY, 42, 0), 42);
  });

  it('accepts a plain integer at or above the minimum', () => {
    process.env[KEY] = '120';
    assert.equal(parseIntEnv(KEY, 0, 1), 120);
  });

  // Regression: parseInt("12abc", 10) === 12, silently turning a typo into a different setting.
  it('rejects a value with trailing garbage', () => {
    process.env[KEY] = '12abc';
    assert.throws(() => parseIntEnv(KEY, 0, 0), new RegExp(`${KEY} must be a whole number`));
  });

  it('rejects a decimal', () => {
    process.env[KEY] = '1.5';
    assert.throws(() => parseIntEnv(KEY, 0, 0), /whole number/);
  });

  // Regression: POLL_INTERVAL_SECONDS=0 would make setInterval spin continuously.
  it('rejects a value below the minimum', () => {
    process.env[KEY] = '0';
    assert.throws(() => parseIntEnv(KEY, 1, 1), new RegExp(`${KEY} must be >= 1, got: 0`));
  });

  it('rejects a negative value even when the minimum is zero', () => {
    process.env[KEY] = '-5';
    assert.throws(() => parseIntEnv(KEY, 0, 0), new RegExp(`${KEY} must be >= 0, got: -5`));
  });

  it('rejects a value above the maximum', () => {
    process.env[KEY] = '70000';
    assert.throws(
      () => parseIntEnv(KEY, 0, 1, 65_535),
      new RegExp(`${KEY} must be between 1 and 65535`)
    );
  });

  it('accepts the maximum itself', () => {
    process.env[KEY] = '65535';
    assert.equal(parseIntEnv(KEY, 0, 1, 65_535), 65_535);
  });
});

describe('validateLogLevel', () => {
  it('defaults to info when unset', () => {
    assert.equal(validateLogLevel(undefined), 'info');
  });

  it('defaults to info when empty', () => {
    assert.equal(validateLogLevel('  '), 'info');
  });

  for (const level of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']) {
    it(`accepts ${level}`, () => {
      assert.equal(validateLogLevel(level), level);
    });
  }

  it('rejects an unknown level', () => {
    assert.throws(() => validateLogLevel('trace'), /LOG_LEVEL must be one of/);
  });
});
