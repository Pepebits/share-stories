import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicBaseUrl, parseIntEnv, validateLogLevel, loadConfig } from '../src/config.js';

// Mirrors how config.ts computes it: this file lives at <root>/test/, so one level up.
const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('loadConfig path resolution', () => {
  const REQUIRED_ENV: Record<string, string> = {
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'hash',
    TELEGRAM_PHONE_NUMBER: '+34600000000',
    PUBLIC_BASE_URL: 'https://stories.example.com',
    INSTAGRAM_ACCOUNT_ID: 'acct_1',
    INSTAGRAM_ACCESS_TOKEN: 'token_abc',
  };

  /** Sets env for the run and restores exactly what was there before, whatever the outcome. */
  function withEnv<T>(overrides: Record<string, string>, run: () => T): T {
    const applied = { ...REQUIRED_ENV, ...overrides };
    const previous: Record<string, string | undefined> = {};
    for (const key of Object.keys(applied)) {
      previous[key] = process.env[key];
      process.env[key] = applied[key];
    }
    try {
      return run();
    } finally {
      for (const key of Object.keys(applied)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  // Regression: DATABASE_PATH used to be left relative to the process cwd, while
  // TELEGRAM_SESSION_FILE and INSTAGRAM_TOKEN_FILE were resolved against the project root —
  // so where the bridge looked for its database depended on the directory it was launched from.
  it('resolves relative DATABASE_PATH and INSTAGRAM_TOKEN_FILE against the project root', () => {
    withEnv(
      {
        DATABASE_PATH: './data/custom-state.db',
        INSTAGRAM_TOKEN_FILE: './data/custom-token.json',
      },
      () => {
        const config = loadConfig();
        assert.equal(config.databasePath, join(projectRoot, 'data', 'custom-state.db'));
        assert.equal(config.instagramTokenFile, join(projectRoot, 'data', 'custom-token.json'));
      }
    );
  });

  it('leaves an already-absolute DATABASE_PATH unchanged', () => {
    withEnv({ DATABASE_PATH: '/var/lib/share-stories/state.db' }, () => {
      const config = loadConfig();
      assert.equal(config.databasePath, '/var/lib/share-stories/state.db');
    });
  });

  it('leaves an already-absolute INSTAGRAM_TOKEN_FILE unchanged', () => {
    withEnv({ INSTAGRAM_TOKEN_FILE: '/var/lib/share-stories/token.json' }, () => {
      const config = loadConfig();
      assert.equal(config.instagramTokenFile, '/var/lib/share-stories/token.json');
    });
  });

  it('resolves the default paths against the project root when unset', () => {
    withEnv({}, () => {
      const config = loadConfig();
      assert.equal(config.databasePath, join(projectRoot, 'data', 'state.db'));
      assert.equal(config.instagramTokenFile, join(projectRoot, 'data', 'instagram-token.json'));
      assert.equal(config.telegram.sessionFile, join(projectRoot, 'data', 'telegram-session.txt'));
    });
  });
});
