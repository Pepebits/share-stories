import type { Logger } from '../../src/utils/logger.js';

/** Winston logger stand-in: swallows output so test runs stay readable. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
