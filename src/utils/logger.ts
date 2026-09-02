import winston from 'winston';

export type Logger = winston.Logger;

/** GramJS ids arrive as BigInt, which JSON.stringify otherwise refuses to serialize. */
export const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export function createLogger(level: string = 'info'): Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, ...rest }) => {
        const base = `${String(timestamp)} [${level.toUpperCase()}] ${String(message)}`;
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest, replacer)}` : '';
        const errStack = typeof stack === 'string' ? `\n${stack}` : '';
        return `${base}${extra}${errStack}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
