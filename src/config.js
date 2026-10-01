import dotenv from 'dotenv';
dotenv.config();

function resolveTokens() {
  let rawToken = process.env.TELEGRAM_BOT_TOKEN ? String(process.env.TELEGRAM_BOT_TOKEN).trim().replace(/^["']|["']$/g, '') : '';
  let rawAdminId = process.env.INITIAL_SUPER_ADMIN_ID ? String(process.env.INITIAL_SUPER_ADMIN_ID).trim().replace(/^["']|["']$/g, '') : '';

  // Check if variables were swapped in secrets:
  // Telegram Bot Token always contains a colon and secret hash: ^\d+:[A-Za-z0-9_-]+$
  // Telegram User ID is always purely numeric: ^\d+$
  const isTokenFormat = (str) => /^\d{6,14}:[A-Za-z0-9_-]{25,}$/.test(str);
  const isNumericUserId = (str) => /^\d{5,14}$/.test(str);

  if (isTokenFormat(rawAdminId) && (isNumericUserId(rawToken) || !rawToken)) {
    console.log('🔄 Detected swapped configuration: TELEGRAM_BOT_TOKEN and INITIAL_SUPER_ADMIN_ID automatically resolved to their correct positions.');
    const temp = rawToken;
    rawToken = rawAdminId;
    rawAdminId = temp;
  }

  return {
    botToken: rawToken,
    superAdminId: rawAdminId
  };
}

const resolved = resolveTokens();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  telegramBotToken: resolved.botToken,
  initialSuperAdminId: resolved.superAdminId,
  webhookSecret: process.env.WEBHOOK_SECRET ? String(process.env.WEBHOOK_SECRET).trim() : '',
  appUrl: process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, '') : '',
  databaseUrl: process.env.DATABASE_URL || '',
  isProduction: process.env.NODE_ENV === 'production'
};

export function validateConfig() {
  const warnings = [];
  if (!config.telegramBotToken) {
    warnings.push('TELEGRAM_BOT_TOKEN is not set. Please set your Telegram Bot token from @BotFather.');
  } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.telegramBotToken)) {
    warnings.push('TELEGRAM_BOT_TOKEN appears incomplete. A valid token looks like 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ.');
  }
  if (!config.initialSuperAdminId) {
    warnings.push('INITIAL_SUPER_ADMIN_ID is not set. Set your numeric Telegram user ID from @userinfobot to access admin features.');
  }
  return {
    valid: Boolean(config.telegramBotToken && /^\d+:[A-Za-z0-9_-]+$/.test(config.telegramBotToken)),
    warnings
  };
}

