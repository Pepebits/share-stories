import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { InstagramPublishConfig } from './types.js';
import { refreshAccessToken } from './graph-api.js';

/**
 * Long-lived Instagram tokens expire 60 days after issue, and nothing renews
 * them on its own. Refreshing mints a *new* token, which can't live in an
 * immutable .env, so the current one is persisted with its expiry and
 * reloaded on boot.
 */

export interface StoredToken {
  accessToken: string;
  /** Epoch ms, or null when the token came straight from .env unrefreshed. */
  expiresAt: number | null;
  refreshedAt: number | null;
  /**
   * sha256 of the .env seed, not the seed itself — the file on disk should only ever hold
   * a live token. A changed .env value means the operator replaced it deliberately.
   */
  seedHash: string;
}

/** Files written before 1.1.0 kept the seed token itself instead of its hash. */
interface StoredTokenFile extends Omit<StoredToken, 'seedHash'> {
  seedHash?: string;
  seededFrom?: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenManagerOptions {
  filePath: string;
  envToken: string;
  accountId: string;
  apiBase?: string;
  /** Refresh once less than this remains before expiry. */
  refreshWhenRemainingMs: number;
  checkIntervalMs: number;
}

const DAY_MS = 86_400_000;

export const DEFAULT_TOKEN_OPTIONS = {
  refreshWhenRemainingMs: 14 * DAY_MS,
  checkIntervalMs: 12 * 60 * 60_000,
};

export class TokenManager {
  private token: StoredToken;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: TokenManagerOptions,
    private readonly logger: Logger
  ) {
    this.token = {
      accessToken: options.envToken,
      expiresAt: null,
      refreshedAt: null,
      seedHash: hashToken(options.envToken),
    };
  }

  /** Config snapshot for a single publish; always carries the live token. */
  config(): InstagramPublishConfig {
    return {
      accountId: this.options.accountId,
      accessToken: this.token.accessToken,
      ...(this.options.apiBase ? { apiBase: this.options.apiBase } : {}),
    };
  }

  get state(): Readonly<StoredToken> {
    return this.token;
  }

  async load(): Promise<void> {
    let stored: StoredTokenFile | null = null;

    try {
      stored = JSON.parse(await readFile(this.options.filePath, 'utf8')) as StoredTokenFile;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn('Token file unreadable, falling back to the .env token', {
          path: this.options.filePath,
          error: errorMessage(error),
        });
      }
    }

    if (!stored?.accessToken) {
      this.logger.info('No stored Instagram token; seeding from .env');
      return;
    }

    const envHash = hashToken(this.options.envToken);
    const migratingLegacyFile =
      stored.seedHash === undefined && stored.seededFrom === this.options.envToken;

    if (stored.seedHash !== envHash && !migratingLegacyFile) {
      this.logger.info(
        'INSTAGRAM_ACCESS_TOKEN changed in .env; discarding the stored refresh chain'
      );
      this.token = {
        accessToken: this.options.envToken,
        expiresAt: null,
        refreshedAt: null,
        seedHash: envHash,
      };
      return;
    }

    this.token = {
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      refreshedAt: stored.refreshedAt,
      seedHash: envHash,
    };
    this.logger.info('Loaded stored Instagram token', {
      expiresInDays: stored.expiresAt
        ? Math.round((stored.expiresAt - Date.now()) / DAY_MS)
        : 'unknown',
    });

    // Rewrite immediately so the plaintext seed from before 1.1.0 never reaches disk again.
    if (migratingLegacyFile) await this.persist();
  }

  /**
   * Refreshes when expiry is near, or when it is unknown because the token
   * came from .env and has never been refreshed. Returns true if it did.
   */
  async refreshIfNeeded(now: number = Date.now()): Promise<boolean> {
    const { expiresAt } = this.token;

    if (expiresAt !== null && expiresAt - now > this.options.refreshWhenRemainingMs) {
      return false;
    }

    if (expiresAt !== null && expiresAt <= now) {
      this.logger.error(
        'Instagram token has already expired; a refresh may be rejected and the ' +
          'token will need re-issuing by hand.'
      );
    }

    try {
      const { accessToken, expiresInSeconds } = await refreshAccessToken(
        this.config(),
        this.logger
      );

      this.token = {
        accessToken,
        expiresAt: expiresInSeconds > 0 ? now + expiresInSeconds * 1000 : null,
        refreshedAt: now,
        seedHash: this.token.seedHash,
      };

      await this.persist();
      return true;
    } catch (error) {
      // Meta refuses to refresh a token younger than 24 hours — expected right after issuing one.
      this.logger.warn('Instagram token refresh did not succeed; will retry', {
        error: errorMessage(error),
      });
      return false;
    }
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.refreshIfNeeded();
    }, this.options.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async persist(): Promise<void> {
    const path = this.options.filePath;

    try {
      await mkdir(dirname(path), { recursive: true });

      // Write-then-rename so a crash mid-write cannot leave a truncated token file, which
      // would lock the bridge out.
      const tempPath = `${path}.tmp`;
      await writeFile(tempPath, JSON.stringify(this.token, null, 2), { mode: 0o600 });
      await rename(tempPath, path);

      this.logger.info('Stored refreshed Instagram token', {
        path,
        expiresInDays: this.token.expiresAt
          ? Math.round((this.token.expiresAt - Date.now()) / DAY_MS)
          : 'unknown',
      });
    } catch (error) {
      // The in-memory token is still good; losing the file only costs the refresh chain on restart.
      this.logger.error('Could not persist the refreshed Instagram token', {
        path,
        error: errorMessage(error),
      });
    }
  }
}
