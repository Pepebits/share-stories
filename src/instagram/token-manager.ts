import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { InstagramPublishConfig } from './types.js';
import { refreshAccessToken } from './graph-api.js';

/**
 * Long-lived Instagram tokens expire 60 days after issue. Nothing renews them
 * on its own, so an unattended bridge silently stops publishing two months in.
 *
 * Refreshing mints a *new* token, which means it cannot live in an immutable
 * .env: the current one is persisted alongside its expiry and reloaded on boot.
 */

export interface StoredToken {
  accessToken: string;
  /** Epoch ms, or null when the token came straight from .env unrefreshed. */
  expiresAt: number | null;
  refreshedAt: number | null;
  /**
   * The .env value this chain started from. If the operator pastes a new token
   * into .env we must abandon the stored chain rather than keep refreshing a
   * token they deliberately replaced.
   */
  seededFrom: string;
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
      seededFrom: options.envToken,
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
    let stored: StoredToken | null = null;

    try {
      stored = JSON.parse(await readFile(this.options.filePath, 'utf8')) as StoredToken;
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

    if (stored.seededFrom !== this.options.envToken) {
      this.logger.info(
        'INSTAGRAM_ACCESS_TOKEN changed in .env; discarding the stored refresh chain'
      );
      this.token = {
        accessToken: this.options.envToken,
        expiresAt: null,
        refreshedAt: null,
        seededFrom: this.options.envToken,
      };
      return;
    }

    this.token = stored;
    this.logger.info('Loaded stored Instagram token', {
      expiresInDays: stored.expiresAt
        ? Math.round((stored.expiresAt - Date.now()) / DAY_MS)
        : 'unknown',
    });
  }

  /**
   * Refresh when expiry is near, or when it is unknown because the token came
   * from .env and has never been through a refresh.
   *
   * Returns true if a refresh actually happened.
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
        seededFrom: this.token.seededFrom,
      };

      await this.persist();
      return true;
    } catch (error) {
      // Meta refuses to refresh a token younger than 24 hours. That is the
      // expected answer right after issuing one, not a fault.
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

      // Write-then-rename so a crash mid-write cannot leave a truncated token
      // file, which would lock the bridge out until someone noticed.
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
      // The in-memory token is still good; losing the file only costs us the
      // refresh chain on the next restart.
      this.logger.error('Could not persist the refreshed Instagram token', {
        path,
        error: errorMessage(error),
      });
    }
  }
}
