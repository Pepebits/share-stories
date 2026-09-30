import {
  AuthKeyDuplicatedError,
  AuthKeyInvalidError,
  AuthKeyUnregisteredError,
  SessionExpiredError,
  SessionRevokedError,
  UserDeactivatedBanError,
  UserDeactivatedError,
} from 'teleproto/errors/index.js';
import { TelegramSessionError, sessionLostError } from './session-error.js';

/**
 * The RPC errors that mean this session will never work again and only a fresh login helps.
 * Listed one by one rather than catching UnauthorizedError wholesale: its other member,
 * SessionPasswordNeededError, is a step in logging in, not a lost session.
 */
const SESSION_LOST = [
  AuthKeyUnregisteredError,
  AuthKeyInvalidError,
  AuthKeyDuplicatedError,
  SessionRevokedError,
  SessionExpiredError,
  UserDeactivatedError,
  UserDeactivatedBanError,
];

/**
 * A TelegramSessionError if `error` says the session is gone, else null — so a revoked session
 * reads as "run login" wherever it is noticed, instead of as a raw RPC error or, in the
 * bridge, as a network problem worth retrying.
 */
export function asSessionError(error: unknown): TelegramSessionError | null {
  if (error instanceof TelegramSessionError) return error;
  if (SESSION_LOST.some((type) => error instanceof type)) {
    return sessionLostError((error as { errorMessage?: string }).errorMessage);
  }
  return null;
}
