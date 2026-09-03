import { Logger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { InstagramPublishConfig } from './types.js';
import { getPublishingLimit, type PublishingLimit } from './graph-api.js';

/**
 * Instagram allows 100 API-published posts per rolling 24 hours, and stories
 * count like anything else. Running past the limit does not fail gracefully —
 * Meta rejects the publish only after the container is built and the media
 * served, so checking first is cheaper than paying that cost first.
 */

export class QuotaExceededError extends Error {
  private constructor(
    readonly used: number,
    readonly total: number,
    readonly reserve: number,
    message: string
  ) {
    super(message);
  }

  static reached(used: number, total: number, reserve: number): QuotaExceededError {
    return new QuotaExceededError(
      used,
      total,
      reserve,
      `Instagram publish quota reached: ${used}/${total} used in the rolling window` +
        (reserve > 0 ? ` (holding ${reserve} back for manual posting)` : '')
    );
  }

  /** Distinct from `reached`: a 0/0 reading would misreport an unknown quota as an empty one. */
  static unknown(reserve: number): QuotaExceededError {
    return new QuotaExceededError(
      0,
      0,
      reserve,
      'Instagram publish quota unknown: content_publishing_limit could not be read, refusing to ' +
        'publish blind'
    );
  }
}

export interface QuotaGuardOptions {
  /** Leave this many publishes unused, e.g. so you can still post by hand. */
  reserve: number;
  /** How long a fetched reading is trusted before asking Meta again. */
  refreshIntervalMs: number;
}

export const DEFAULT_QUOTA_OPTIONS: QuotaGuardOptions = {
  reserve: 0,
  refreshIntervalMs: 10 * 60_000,
};

export class QuotaGuard {
  private limit: PublishingLimit | null = null;
  private fetchedAt = 0;

  constructor(
    private readonly getConfig: () => InstagramPublishConfig,
    private readonly options: QuotaGuardOptions,
    private readonly logger: Logger
  ) {}

  get snapshot(): Readonly<PublishingLimit> | null {
    return this.limit;
  }

  /**
   * Throws QuotaExceededError when there is no room left — callers should treat that as
   * "come back later", not a failed story, since the rolling window frees up on its own.
   */
  async ensureCapacity(now: number = Date.now()): Promise<void> {
    if (!this.limit || now - this.fetchedAt >= this.options.refreshIntervalMs) {
      await this.refresh(now);
    }

    // A failed refresh leaves no reading at all; publishing blind risks burning a container
    // against an unseen limit.
    if (!this.limit) {
      throw QuotaExceededError.unknown(this.options.reserve);
    }

    const usable = this.limit.total - this.options.reserve;
    if (this.limit.used >= usable) {
      throw QuotaExceededError.reached(this.limit.used, this.limit.total, this.options.reserve);
    }
  }

  /**
   * Counts a publish locally so the guard stays accurate between refreshes; Meta's own
   * counter is authoritative and overwrites this on the next fetch.
   */
  recordPublish(): void {
    if (!this.limit) return;

    this.limit = {
      ...this.limit,
      used: this.limit.used + 1,
      remaining: Math.max(0, this.limit.remaining - 1),
    };

    const usable = this.limit.total - this.options.reserve;
    if (this.limit.used >= usable * 0.9) {
      this.logger.warn('Approaching the Instagram publish quota', {
        used: this.limit.used,
        usable,
      });
    }
  }

  private async refresh(now: number): Promise<void> {
    try {
      this.limit = await getPublishingLimit(this.getConfig(), this.logger);
      this.fetchedAt = now;
    } catch (error) {
      this.logger.error('Could not read the Instagram publish quota', {
        error: errorMessage(error),
      });
      // Deliberately leave this.limit as-is: a stale reading plus local counting beats no
      // idea at all — only a guard that has never succeeded blocks publishing outright.
    }
  }
}
