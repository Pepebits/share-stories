/** Thrown when the configured session is missing or Telegram has revoked it. */
export class TelegramSessionError extends Error {}

/** The one remedy for every way a session can be lost, so the message never varies in what to do. */
const LOGIN_HINT = 'Run `pnpm run login`; it writes the session file at TELEGRAM_SESSION_FILE.';

/** `reason` is Telegram's own code (e.g. SESSION_REVOKED) when it told us one. */
export function sessionLostError(reason?: string): TelegramSessionError {
  return new TelegramSessionError(
    reason
      ? `Telegram session is no longer valid (${reason}). ${LOGIN_HINT}`
      : `Telegram session is missing or revoked. ${LOGIN_HINT}`
  );
}
