import { Bot } from 'grammy';
import { config } from '../config.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerMessageHandlers } from './handlers/messages.js';
import { registerUserHandlers } from './handlers/user.js';

let botInstance = null;

export function getBot() {
  if (botInstance) return botInstance;

  if (!config.telegramBotToken) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN is not configured yet. Bot instance is pending credentials.');
    return null;
  }

  const bot = new Bot(config.telegramBotToken);

  // Global error handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`, err.error);
  });

  // Register feature handlers
  registerUserHandlers(bot);
  registerAdminHandlers(bot);
  registerMessageHandlers(bot);

  // Fallback for unhandled callback queries (e.g., 'noop')
  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  botInstance = bot;
  return botInstance;
}
