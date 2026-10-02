import http from 'http';
import { getBot } from './src/bot/index.js';
import { config, validateConfig } from './src/config.js';
import { db } from './src/db/index.js';

// Safe Global Process Handlers
process.on('uncaughtException', (err) => {
  console.error('💥 [Server] Uncaught Exception caught safely:', {
    message: err?.message || String(err),
    stack: err?.stack
  });
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('⚠️ [Server] Unhandled Rejection caught safely:', msg);
});

let isReady = false;
let botInfo = null;
let activeBotInstance = null;

// Start Long Polling Engine with Auto-Reconnect
async function bootstrap() {
  console.log('🚀 Bootstrapping VYRON Business Bot in Long Polling mode...');
  try {
    await db.init();
  } catch (err) {
    console.error('⚠️ Database init error, continuing with fallback:', err.message);
  }

  const bot = getBot();
  if (bot) {
    activeBotInstance = bot;
    try {
      await bot.init();
      botInfo = bot.botInfo;
      console.log(`🤖 Telegram Bot Authenticated: @${botInfo.username} (${botInfo.first_name})`);

      // Commands setup
      try {
        await bot.api.setMyCommands([
          { command: 'start', description: '🏠 Open VYRON Main Menu' },
          { command: 'menu', description: '📱 Navigation Menu' },
          { command: 'orders', description: '📦 My Orders & Tracking' },
          { command: 'ai', description: '🤖 VYRON AI Assistant' },
          { command: 'account', description: '👤 My Account Profile' },
          { command: 'support', description: '🎫 Customer Support Center' },
          { command: 'admin', description: '⚙️ Admin Control Panel (Admins)' }
        ]);

        await bot.api.setChatMenuButton({
          menu_button: { type: 'commands' }
        });
        console.log('📱 Telegram Menu Button and Commands configured.');
      } catch (cmdErr) {
        console.warn('⚠️ Could not set menu button:', cmdErr.message);
      }

      // Delete any webhook and drop backlogged updates
      try {
        console.log('🧹 Clearing webhook registration & dropping pending updates...');
        await bot.api.deleteWebhook({ drop_pending_updates: true });
      } catch (whErr) {
        console.warn('⚠️ Delete webhook warning:', whErr.message);
      }

      // Start Polling with Reconnect Loop
      let retryCount = 0;
      const startPollingWithRetry = async () => {
        while (true) {
          try {
            console.log('📡 Starting grammY long polling with drop_pending_updates: true...');
            await bot.start({
              drop_pending_updates: true,
              allowed_updates: ['message', 'callback_query'],
              onStart: (info) => {
                retryCount = 0;
                console.log(`🚀 Telegram Bot @${info.username} is actively polling for updates.`);
              }
            });
          } catch (pollingErr) {
            const errorMsg = pollingErr?.message || String(pollingErr);
            const isConflict = errorMsg.includes('409') || errorMsg.includes('Conflict') || pollingErr?.error_code === 409;

            // Stop runner state on error
            try {
              await bot.stop();
            } catch {}

            if (isConflict) {
              console.warn('⚠️ [409 Conflict] Another getUpdates connection is open. Waiting 15s for the old connection to release before retrying...');
              await new Promise(r => setTimeout(r, 15000));
            } else {
              retryCount++;
              const delay = Math.min(2000 * Math.pow(1.5, retryCount), 30000);
              console.error(`⚠️ Polling error (${errorMsg}). Reconnecting in ${Math.round(delay / 1000)}s...`);
              await new Promise(r => setTimeout(r, delay));
            }
          }
        }
      };

      startPollingWithRetry();
    } catch (err) {
      console.error('⚠️ Bot initialization error:', err.message);
    }
  } else {
    console.log('ℹ️ Bot token pending. Set TELEGRAM_BOT_TOKEN to activate bot.');
  }

  isReady = true;
}

// Graceful Shutdown
const shutdown = async (signal) => {
  console.log(`🛑 [Shutdown] Received ${signal}. Stopping polling gracefully...`);
  try {
    if (activeBotInstance) {
      await activeBotInstance.stop();
    }
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Lightweight dummy HTTP server for Render/Cloud Run port-binding requirement
const port = process.env.PORT || config.port || 3000;
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      message: 'VYRON Business Bot is running in Long Polling mode',
      mode: 'long_polling',
      ready: isReady,
      bot: botInfo ? `@${botInfo.username}` : 'unconfigured',
      database: db.type,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
  }

  // Safe 200 OK fallback for any other health probe
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: url }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`🌐 [Render Web Service] HTTP port-binding active on port ${port} (/ and /health ready)`);
  bootstrap();
});
