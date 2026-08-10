import TelegramBot from 'node-telegram-bot-api';
import { Logger } from '../utils/logger.js';

export function createBot(token: string, logger: Logger): TelegramBot {
  const bot = new TelegramBot(token, {
    polling: false,
  });

  bot.on('error', (error: Error) => {
    logger.error('Telegram Bot API error', { error: error.message });
  });

  bot.on('polling_error', (error: Error) => {
    logger.error('Telegram polling error', { error: error.message });
  });

  return bot;
}

export async function setupCommands(bot: TelegramBot, logger: Logger): Promise<void> {
  // These commands register with Telegram but since we use polling:false,
  // we'd need webhook or manual getUpdates. They serve as documentation.
  const commands = [
    { command: 'start', description: 'Start the bot and see available commands' },
    { command: 'status', description: 'Check bridge status' },
    { command: 'help', description: 'Show help message' },
  ];

  try {
    await bot.setMyCommands(commands);
    logger.info('Bot commands registered');
  } catch (error) {
    logger.warn('Failed to set bot commands', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getMe(bot: TelegramBot): Promise<string> {
  const me = await bot.getMe();
  return `@${me.username}`;
}
