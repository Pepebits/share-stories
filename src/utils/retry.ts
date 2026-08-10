import { Logger } from './logger.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  logger?: Logger;
  operation: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, logger, operation } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = Math.random() * delay * 0.3;
        const waitMs = Math.floor(delay + jitter);

        logger?.warn(
          `[${operation}] attempt ${attempt + 1}/${maxRetries + 1} failed, ` +
            `retrying in ${Math.round(waitMs / 1000)}s: ${lastError.message}`
        );

        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw new Error(
    `[${operation}] all ${maxRetries + 1} attempts failed: ${lastError?.message}`
  );
}
