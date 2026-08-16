import { Logger } from '../utils/logger.js';
import { InstagramPublishConfig } from './types.js';
import { getPublishingLimit, type PublishingLimit } from './graph-api.js';

/**
 * Instagram allows 100 API-published posts per rolling 24 hours, and a live
 * test confirmed stories are counted like anything else.
 *
 * Running past the limit does not fail gracefully — Meta rejects the publish
 * after the container has already been built and the media served, so the
 * cost is paid before the refusal arrives. Checking first is cheaper.
 */

export class QuotaExceededError extends Error {
  constructor(
    readonly used: number,
    readonly total: number,
    readonly reserve: number
  ) {
    super(
      `Instagram publish quota reached: ${used}/${total} used in the rolling window` +
        (reserve > 0 ? ` (holding ${reserve} back for manual posting)` : '')
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
   * Throws QuotaExceededError when there is no room left. Callers should treat
   * that as "come back later", not as a failed story: the quota is a rolling
   * window and will free up on its own.
   */
  async ensureCapacity(now: number = Date.now()): Promise<void> {
    if (!this.limit || now - this.fetchedAt >= this.options.refreshIntervalMs) {
      await this.refresh(now);
    }

    // A failed refresh leaves no reading at all. Publishing blind risks
    // burning a container against a limit we cannot see, so refuse.
    if (!this.limit) {
      throw new QuotaExceededError(0, 0, this.options.reserve);
    }

    const usable = this.limit.total - this.options.reserve;
    if (this.limit.used >= usable) {
      throw new QuotaExceededError(this.limit.used, this.limit.total, this.options.reserve);
    }
  }

  /**
   * Count a publish locally so the guard stays accurate between refreshes.
   * Meta's own counter is authoritative and overwrites this on the next fetch.
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
        error: error instanceof Error ? error.message : String(error),
      });
      // Deliberately leave this.limit as-is: a stale reading plus local
      // counting is still better than no idea at all. Only a guard that has
      // never succeeded blocks publishing outright.
    }
  }
}
