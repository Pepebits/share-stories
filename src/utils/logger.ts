import winston from 'winston';

export type Logger = winston.Logger;

export function createLogger(level: string = 'info'): Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, ...rest }) => {
        const base = `${timestamp} [${level.toUpperCase()}] ${message}`;
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
        const errStack = stack ? `\n${stack}` : '';
        return `${base}${extra}${errStack}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
