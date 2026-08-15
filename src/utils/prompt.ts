import { createInterface } from 'node:readline/promises';

/**
 * First-run Telegram auth needs a login code that only exists at the moment
 * it is asked for. Under systemd there is no one to ask, so prompting must
 * fail loudly instead of hanging forever on a stdin that will never deliver.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export class NonInteractiveError extends Error {}

export async function prompt(question: string, mask = false): Promise<string> {
  if (!isInteractive()) {
    throw new NonInteractiveError(
      `Cannot ask for "${question.trim()}" without a terminal. ` +
        'Run the app interactively once to authenticate, then put the resulting ' +
        'session string in TELEGRAM_SESSION_STRING.'
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    if (!mask) {
      return (await rl.question(question)).trim();
    }

    // readline has no supported way to suppress echo, and a 2FA password
    // must not be left sitting in the scrollback.
    const internal = rl as unknown as {
      output: NodeJS.WriteStream;
      _writeToOutput: (text: string) => void;
    };
    const original = internal._writeToOutput.bind(rl);

    internal._writeToOutput = (text: string) => {
      // The prompt itself still has to be visible; only the typed reply is hidden.
      if (text.includes(question)) original(text);
      else if (text.trim().length > 0) internal.output.write('*');
      else original(text);
    };

    const answer = await rl.question(question);
    internal.output.write('\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}
