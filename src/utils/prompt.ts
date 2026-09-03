import { createInterface } from 'node:readline/promises';

/**
 * First-run Telegram auth needs a login code that only exists when asked for. Under systemd
 * there is no one to ask, so prompting must fail loudly instead of hanging on stdin forever.
 */

export interface PromptIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const defaultIO = (): PromptIO => ({ input: process.stdin, output: process.stdout });

export function isInteractive(io: PromptIO = defaultIO()): boolean {
  return io.input.isTTY === true && io.output.isTTY === true;
}

export class NonInteractiveError extends Error {}

export async function prompt(
  question: string,
  mask = false,
  io: PromptIO = defaultIO()
): Promise<string> {
  if (!isInteractive(io)) {
    throw new NonInteractiveError(
      `Cannot ask for "${question.trim()}" without a terminal. ` +
        'Run the app interactively once to authenticate, then put the resulting ' +
        'session string in TELEGRAM_SESSION_STRING.'
    );
  }

  return mask ? readMasked(question, io) : readPlain(question, io);
}

async function readPlain(question: string, io: PromptIO): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * A 2FA password must not be left in the scrollback, and readline/promises offers no
 * supported way to suppress echo, so the terminal is put in raw mode and keystrokes handled here.
 */
function readMasked(question: string, io: PromptIO): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { input, output } = io;
    const wasRaw = input.isRaw;

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case '\r':
          case '\n':
            cleanup();
            output.write('\n');
            resolve(value.trim());
            return;

          // Ctrl-C: raw mode swallows the signal, so honour it by hand.
          case '\u0003':
            cleanup();
            output.write('\n');
            reject(new Error('Cancelled'));
            return;

          case '\u007f':
          case '\b':
            if (value.length > 0) {
              value = value.slice(0, -1);
              output.write('\b \b');
            }
            break;

          default:
            // Ignore other control characters rather than storing them.
            if (char >= ' ') {
              value += char;
              output.write('*');
            }
        }
      }
    };

    input.on('data', onData);
  });
}
