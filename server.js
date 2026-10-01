import express from 'express';
import http from 'http';
import https from 'https';
import { getBot } from './src/bot/index.js';
import { config, validateConfig } from './src/config.js';
import { db } from './src/db/index.js';

// Safe Global Process Handlers (prevent process crash on transient errors)
process.on('uncaughtException', (err) => {
  console.error('💥 [Server] Uncaught Exception caught safely:', err.message);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('⚠️ [Server] Unhandled Rejection caught safely:', msg);
});

const app = express();
app.use(express.json());

let isReady = false;
let botInfo = null;
let activeMode = 'initializing';
let lastWebhookInfo = null;

// Initialize Database & Bot
async function bootstrap() {
  console.log('🚀 Bootstrapping VYRON Business Bot Server...');
  await db.init();

  const bot = getBot();
  if (bot) {
    try {
      // Ensure bot metadata is initialized in grammY
      await bot.init();
      botInfo = bot.botInfo;
      console.log(`🤖 Telegram Bot Authenticated: @${botInfo.username} (${botInfo.first_name})`);

      // Configure persistent Telegram Menu Button & official Bot Commands
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
        console.log('📱 Persistent Telegram Menu Button and Commands configured successfully!');
      } catch (cmdErr) {
        console.warn('⚠️ Could not set Telegram menu button or commands:', cmdErr.message);
      }

      // Query current Telegram webhook registration from Telegram's servers
      try {
        lastWebhookInfo = await bot.api.getWebhookInfo();
        console.log(`📡 Telegram Remote Webhook State: URL="${lastWebhookInfo.url || '(none)'}", PendingUpdates=${lastWebhookInfo.pending_update_count}`);
        if (lastWebhookInfo.last_error_message) {
          console.warn(`⚠️ Telegram Webhook Last Error: ${lastWebhookInfo.last_error_message} (${new Date(lastWebhookInfo.last_error_date * 1000).toISOString()})`);
        }
      } catch (whErr) {
        console.warn('⚠️ Could not query getWebhookInfo from Telegram API:', whErr.message);
      }

      // Determine deployment mode:
      // In production Cloud Run: Public HTTPS endpoint receives POST /api/telegram-webhook
      // In temporary AI Studio dev: The ais-dev- URL is behind a Google OAuth/cookie proxy returning 302.
      const isPublicProductionUrl = config.appUrl && 
        config.appUrl.startsWith('https://') && 
        !config.appUrl.includes('localhost') && 
        !config.appUrl.includes('ais-dev-');

      const explicitWebhook = process.env.TELEGRAM_MODE === 'webhook';
      const explicitPolling = process.env.TELEGRAM_MODE === 'polling';

      if (isPublicProductionUrl || explicitWebhook) {
        // PRODUCTION WEBHOOK MODE
        activeMode = 'webhook';
        const expectedWebhookUrl = `${config.appUrl}/api/telegram-webhook`;

        // Idempotent registration: only call setWebhook if URL is different or explicitly requested
        if (!lastWebhookInfo || lastWebhookInfo.url !== expectedWebhookUrl) {
          console.log(`🌐 Registering Telegram Webhook to public endpoint: ${expectedWebhookUrl}`);
          const opts = {
            drop_pending_updates: false,
            allowed_updates: ['message', 'callback_query']
          };
          if (config.webhookSecret) {
            opts.secret_token = config.webhookSecret;
          }
          await bot.api.setWebhook(expectedWebhookUrl, opts);
          lastWebhookInfo = await bot.api.getWebhookInfo();
          console.log('✅ Telegram Webhook registered successfully!');
        } else {
          console.log(`✅ Telegram Webhook is already correctly registered to: ${expectedWebhookUrl}`);
        }
      } else {
        // Check if Telegram already has an external production webhook registered
        if (lastWebhookInfo && lastWebhookInfo.url && lastWebhookInfo.url.startsWith('https://')) {
          activeMode = 'webhook';
          console.log(`🌐 Preserving existing registered Telegram Webhook: ${lastWebhookInfo.url}`);
          console.log('ℹ️ Server ready to receive webhook updates on POST /api/telegram-webhook.');
        } else if (explicitPolling || (!config.appUrl || config.appUrl.includes('ais-dev-'))) {
          // Dev / Polling fallback
          activeMode = 'polling';
          console.log('🔄 Dev environment detected (no public webhook URL configured).');
          console.log('📡 Starting background polling for interactive testing...');
          bot.start({
            drop_pending_updates: false,
            onStart: (info) => {
              console.log(`🚀 Telegram Bot @${info.username} is polling for updates.`);
            }
          });
        } else {
          activeMode = 'webhook';
          console.log('🌐 Webhook mode active. Waiting for incoming webhook calls.');
        }
      }
    } catch (err) {
      console.error('⚠️ Could not complete Telegram bot initialization:', err.message);
    }
  } else {
    console.log('ℹ️ Server running in configuration mode. Set TELEGRAM_BOT_TOKEN to activate bot.');
  }

  isReady = true;
}

// 1. Health Endpoint (GET /health)
// Returns clean production health diagnostics without exposing any secrets
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    dbStatus = db.isInitialized ? 'connected' : 'disconnected';
    if (db.type === 'postgres' && db.pool) {
      await db.pool.query('SELECT 1');
    }
  } catch {
    dbStatus = 'error';
  }

  let tgStatus = 'disconnected';
  let webhookStatus = 'not_configured';
  let webhookUrl = null;
  let pendingUpdates = 0;
  let lastErrorDate = null;
  let lastErrorMessage = null;

  const bot = getBot();
  if (bot && botInfo) {
    tgStatus = 'connected';
    try {
      const wh = await bot.api.getWebhookInfo();
      if (wh && wh.url) {
        webhookStatus = 'configured';
        webhookUrl = wh.url;
        pendingUpdates = wh.pending_update_count || 0;
        lastErrorDate = wh.last_error_date ? new Date(wh.last_error_date * 1000).toISOString() : null;
        lastErrorMessage = wh.last_error_message || null;
      } else {
        webhookStatus = activeMode === 'polling' ? 'polling_active' : 'missing';
      }
    } catch (e) {
      tgStatus = 'error: ' + e.message;
    }
  }

  const isHealthy = isReady && (dbStatus === 'connected') && (tgStatus === 'connected');

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    ready: isReady,
    database: dbStatus,
    databaseType: db.type,
    telegram: tgStatus,
    webhook: webhookStatus,
    webhookUrl,
    pendingUpdates,
    lastErrorDate,
    lastErrorMessage,
    runtime: 'cloud_run_compatible',
    uptime: process.uptime(),
    mode: activeMode
  });
});

// 2. Telegram Webhook Endpoint (POST /api/telegram-webhook & /webhook)
// Cloud Run wake-up entry point for Telegram
const handleWebhookRequest = async (req, res) => {
  // Secret Token Validation
  if (config.webhookSecret) {
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== config.webhookSecret) {
      console.warn('⛔ Invalid Telegram Webhook secret token received');
      return res.status(403).json({ error: 'Unauthorized webhook request' });
    }
  }

  const update = req.body;
  if (!update || !update.update_id) {
    return res.status(400).send('Bad Request: Missing update_id');
  }

  // CRITICAL: Respond 200 OK immediately so Telegram never times out
  res.status(200).json({ ok: true });

  // Process update asynchronously in background
  setImmediate(async () => {
    try {
      // Deduplication / Idempotency Check
      const alreadyProcessed = await db.isUpdateProcessed(update.update_id);
      if (alreadyProcessed) return;

      // Mark as processed
      await db.markUpdateProcessed(update.update_id);

      const bot = getBot();
      if (!bot) return;

      // Process update safely in grammY
      await bot.handleUpdate(update);
    } catch (err) {
      console.error('❌ Error handling Telegram update asynchronously:', err.message);
    }
  });
};

app.post('/api/telegram-webhook', handleWebhookRequest);
app.post('/webhook', handleWebhookRequest);
app.post('/', (req, res, next) => {
  if (req.body && req.body.update_id) return handleWebhookRequest(req, res);
  next();
});

// 3. API Status endpoint
app.get('/api/status', async (req, res) => {
  const validation = validateConfig();
  const stats = await db.getDashboardStats();
  const admins = await db.getAdmins();

  res.json({
    appUrl: config.appUrl,
    webhookEndpoint: `${config.appUrl}/api/telegram-webhook`,
    botTokenConfigured: Boolean(config.telegramBotToken),
    botInfo,
    databaseType: db.type,
    superAdminId: config.initialSuperAdminId ? 'Configured' : 'Missing',
    adminsCount: admins.length,
    warnings: validation.warnings,
    stats
  });
});

// 4. Manual / Scriptable Webhook Setup Endpoint
app.post('/api/setup-webhook', async (req, res) => {
  const bot = getBot();
  if (!bot) {
    return res.status(400).json({ error: 'Bot token is not configured yet.' });
  }

  const targetUrl = req.body.url || (config.appUrl ? `${config.appUrl}/api/telegram-webhook` : '');
  if (!targetUrl || !targetUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Please provide a valid HTTPS target URL' });
  }

  try {
    const opts = {
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query']
    };
    if (config.webhookSecret) {
      opts.secret_token = config.webhookSecret;
    }
    await bot.api.setWebhook(targetUrl, opts);
    const webhookInfo = await bot.api.getWebhookInfo();
    activeMode = 'webhook';
    return res.json({ success: true, message: 'Webhook set successfully', webhookInfo });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Clean Diagnostics Operational Dashboard (GET /)
app.get('/', async (req, res) => {
  const stats = await db.getDashboardStats();
  const validation = validateConfig();
  const webhookUrl = config.appUrl ? `${config.appUrl}/api/telegram-webhook` : 'https://<YOUR_APP_URL>/api/telegram-webhook';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Master Business Bot - Operational Console</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased p-6 md:p-12">
  <div class="max-w-4xl mx-auto space-y-8">
    
    <!-- Header -->
    <div class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-6 gap-4">
      <div>
        <div class="flex items-center gap-3">
          <span class="text-3xl">🤖</span>
          <h1 class="text-2xl font-bold tracking-tight text-white">VYRON Business Bot</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">Production Webhook Server & Operational Controller</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${botInfo ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}">
          ● ${botInfo ? 'Bot Online (@' + botInfo.username + ')' : 'Pending Bot Token'}
        </span>
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-950 text-blue-400 border border-blue-800">
          DB: ${db.type.toUpperCase()}
        </span>
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-purple-950 text-purple-400 border border-purple-800">
          MODE: ${activeMode.toUpperCase()}
        </span>
      </div>
    </div>

    <!-- Status Alerts -->
    ${validation.warnings.length > 0 ? `
    <div class="bg-amber-950/50 border border-amber-800/80 rounded-xl p-5 text-amber-200 text-sm space-y-2">
      <div class="font-semibold flex items-center gap-2">⚠️ Configuration Checklist:</div>
      <ul class="list-disc list-inside space-y-1 text-xs text-amber-300">
        ${validation.warnings.map(w => `<li>${w}</li>`).join('')}
      </ul>
    </div>` : ''}

    <!-- Live Metrics Grid -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs font-medium">Registered Users</div>
        <div class="text-2xl font-bold text-white mt-1">${stats.totalUsers}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs font-medium">Total Orders</div>
        <div class="text-2xl font-bold text-white mt-1">${stats.totalOrders}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs font-medium">Pending Approvals</div>
        <div class="text-2xl font-bold text-amber-400 mt-1">${stats.pendingOrders + stats.pendingPayments}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs font-medium">Gross Revenue</div>
        <div class="text-2xl font-bold text-emerald-400 mt-1">₹${stats.totalSales}</div>
      </div>
    </div>

    <!-- Webhook Integration Card -->
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
      <h2 class="text-lg font-semibold text-white flex items-center gap-2">
        <span>🌐</span> Telegram Webhook Details (Production Endpoint)
      </h2>
      <div class="text-xs text-slate-400 space-y-1">
        <p>In production Cloud Run, Telegram delivers all user interactions directly to this HTTPS POST endpoint. This allows continuous 24/7 uptime without container sleep or polling timeouts.</p>
      </div>

      <div class="bg-slate-950 p-4 rounded-lg font-mono text-xs border border-slate-800 text-slate-300 break-all select-all">
        ${webhookUrl}
      </div>

      <div class="pt-2 flex flex-wrap gap-3">
        <a href="/health" target="_blank" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors">
          Inspect /health Endpoint
        </a>
        <a href="/api/status" target="_blank" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors">
          Inspect /api/status JSON
        </a>
      </div>
    </div>

    <!-- Quick Setup Guide -->
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
      <h2 class="text-lg font-semibold text-white flex items-center gap-2">
        <span>⚙️</span> Environment Setup & Super Admin
      </h2>
      <div class="text-xs text-slate-300 space-y-3 leading-relaxed">
        <div class="p-3 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs">
          TELEGRAM_BOT_TOKEN="your_token_from_botfather"<br>
          INITIAL_SUPER_ADMIN_ID="${config.initialSuperAdminId || 'your_numeric_telegram_user_id'}"<br>
          APP_URL="${config.appUrl || 'https://your-domain.run.app'}"
        </div>
        <p>1. Send <code class="text-emerald-400 font-semibold">/start</code> to your bot on Telegram to open the main customer menu.</p>
        <p>2. Send <code class="text-emerald-400 font-semibold">/admin</code> from your Super Admin account to access the full Inline-Keyboard Admin Panel.</p>
      </div>
    </div>

  </div>
</body>
</html>`;

  res.send(html);
});

// Graceful Shutdown
const shutdown = async (signal) => {
  console.log(`🛑 [Server] Received ${signal}. Starting graceful shutdown...`);
  isReady = false;
  if (db.pool) {
    try {
      await db.pool.end();
      console.log('📦 Database pool closed cleanly.');
    } catch (e) {
      console.error('Error closing DB pool:', e.message);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep-Alive Self-Ping Interval
function setupKeepAliveHeartbeat(port) {
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  setInterval(() => {
    try {
      const localUrl = `http://127.0.0.1:${port}/health`;
      http.get(localUrl, (res) => { res.resume(); }).on('error', () => {});

      if (config.appUrl && config.appUrl.startsWith('https://') && !config.appUrl.includes('localhost')) {
        https.get(`${config.appUrl}/health`, (res) => { res.resume(); }).on('error', () => {});
      }
    } catch {}
  }, INTERVAL_MS);
  console.log('⏰ [Keep-Alive] 10-minute self-ping heartbeat active.');
}

// Start listening on process.env.PORT
bootstrap().then(() => {
  const listenPort = process.env.PORT || config.port || 3000;
  app.listen(listenPort, '0.0.0.0', () => {
    console.log(`📡 VYRON Business Bot Server running on port ${listenPort}`);
    console.log(`🩺 Health check ready at http://localhost:${listenPort}/health`);
    setupKeepAliveHeartbeat(listenPort);
  });
}).catch((err) => {
  console.error('Fatal initialization error:', err);
});
