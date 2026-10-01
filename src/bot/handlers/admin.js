import { InlineKeyboard } from 'grammy';
import { db } from '../../db/index.js';
import { keyboards } from '../keyboards.js';
import { stateManager } from '../state.js';

// Strict server-side authorization check
export async function checkAdmin(ctx) {
  const fromId = ctx.from?.id;
  if (!fromId) return { isAdmin: false, isSuperAdmin: false, admin: null };
  const admin = await db.getAdmin(fromId);
  if (!admin) return { isAdmin: false, isSuperAdmin: false, admin: null };
  return {
    isAdmin: true,
    isSuperAdmin: admin.role === 'super_admin',
    admin
  };
}

export function registerAdminHandlers(bot) {
  // /admin command
  bot.command('admin', async (ctx) => {
    const { isAdmin, isSuperAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return ctx.reply('⛔ *Access Denied.*\nYou do not have administrator permissions.', { parse_mode: 'Markdown' });
    }

    const msg = `⚙️ *Admin Control Panel*\n\n` +
      `Welcome, Administrator *${ctx.from.first_name}* ${isSuperAdmin ? '(👑 Super Admin)' : ''}.\n` +
      `Use the bottom menu buttons to manage catalog, orders, payments, force channels, and payouts:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReplyMenu(isSuperAdmin)
    });
  });

  // Main Admin Menu Callback (fallback)
  bot.callbackQuery('admin:menu', async (ctx) => {
    const { isAdmin, isSuperAdmin } = await checkAdmin(ctx);
    if (!isAdmin) {
      return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    }
    await ctx.answerCallbackQuery().catch(() => {});
    stateManager.clear(ctx.from.id);

    const msg = `⚙️ *Admin Control Panel*\n\n` +
      `Role: *${isSuperAdmin ? '👑 Super Admin' : '🛡️ Admin'}*\n` +
      `Select a management module from the bottom menu:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReplyMenu(isSuperAdmin)
    });
  });

  // ==========================================
  // BOTTOM KEYBOARD NAVIGATION LISTENERS
  // ==========================================

  // Back to Admin Main Menu
  bot.hears(/^🔙 Back to Admin/i, async (ctx) => {
    const { isAdmin, isSuperAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    stateManager.clear(ctx.from.id);

    await ctx.reply('⚙️ *Admin Control Panel*', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReplyMenu(isSuperAdmin)
    });
  });

  // Back to User Menu
  bot.hears(/^🔙 Back to User Menu/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.resetNav(ctx.from.id, 'four_button');

    await ctx.reply('✨ *Returned to Customer View*', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.fourButtonMenu()
    });
  });

  // 1. DASHBOARD
  bot.hears(/^📊 Dashboard/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const stats = await db.getDashboardStats();
    const msg = `📊 *Executive Dashboard*\n\n` +
      `👥 *Total Customers:* ${stats.totalUsers}\n` +
      `📦 *Total Orders:* ${stats.totalOrders}\n` +
      `⏳ *Pending Orders:* ${stats.pendingOrders}\n` +
      `✅ *Completed Orders:* ${stats.completedOrders}\n` +
      `💳 *Pending Payments:* ${stats.pendingPayments}\n` +
      `🎫 *Open Support Tickets:* ${stats.openTickets}\n\n` +
      `💰 *Total Revenue:* ₹${stats.totalSales}\n` +
      `🛍️ *Product Sales:* ₹${stats.productSales}\n` +
      `🧑💻 *Service Sales:* ₹${stats.serviceSales}`;

    const kb = new InlineKeyboard()
      .text('📦 Pending Orders', 'admin:orders:pending')
      .text('💳 Review Payments', 'admin:payments:pending')
      .row()
      .text('🎫 Open Tickets', 'admin:support:open');

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  // 2. PRODUCTS MANAGEMENT
  const listAdminProducts = async (ctx) => {
    const products = await db.getProducts();
    if (products.length === 0) {
      return ctx.reply('🛍️ *Manage Products*\n\nNo products found in the catalog. Tap *➕ Add Product* below to create one.');
    }

    let msg = `🛍️ *Products Catalog (${products.length})*\n\n`;
    const kb = new InlineKeyboard();
    products.forEach((p, idx) => {
      const statusIcon = p.is_active ? '🟢' : '🔴';
      const stockText = p.is_unlimited ? 'Unlimited' : `${p.stock}`;
      msg += `*${idx + 1}. ${p.name}* (₹${p.price})\n` +
        `• Status: ${statusIcon} ${p.is_active ? 'Active' : 'Disabled'} | Stock: ${stockText}\n\n`;
      kb.text(`⚙️ Manage "${p.name.slice(0, 16)}"`, `admin:view_prod:${p.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  };

  bot.hears(/^🗂️ Products/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    await ctx.reply('🗂️ *Products Management*\n\nUse the bottom buttons to add or list products:', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminProductsReplyMenu()
    });
    await listAdminProducts(ctx);
  });

  bot.hears(/^📋 List Products/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await listAdminProducts(ctx);
  });

  bot.hears(/^➕ Add Product/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    stateManager.set(ctx.from.id, { step: 'admin_add_product_name' });
    await ctx.reply(
      '🛍️ *Add New Product (Step 1/6)*\n\n' +
      'Please reply with the *Name* of the product:',
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'admin:menu')
      }
    );
  });

  bot.callbackQuery('admin:add_product:prompt', async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    stateManager.set(ctx.from.id, { step: 'admin_add_product_name' });
    await ctx.reply(
      '🛍️ *Add New Product (Step 1/6)*\n\n' +
      'Please reply with the *Name* of the product:',
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'admin:menu')
      }
    );
  });

  bot.callbackQuery(/^admin:view_prod:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const p = await db.getProduct(ctx.match[1]);
    if (!p) return ctx.reply('⚠️ Product not found.');

    const msg = `🛍️ *Product: ${p.name}*\n\n` +
      `• *Price:* ₹${p.price}\n` +
      `• *Type:* ${p.type}\n` +
      `• *Stock:* ${p.is_unlimited ? 'Unlimited' : p.stock}\n` +
      `• *Status:* ${p.is_active ? '🟢 Active' : '🔴 Disabled'}\n` +
      `• *Description:* ${p.description}\n` +
      (p.delivery_info ? `• *Delivery Info:* ${p.delivery_info}\n` : '');

    const kb = new InlineKeyboard()
      .text(p.is_active ? '🔴 Disable' : '🟢 Enable', `admin:toggle_prod:${p.id}`)
      .text('🗑️ Delete Product', `admin:del_prod:${p.id}`)
      .row()
      .text('✏️ Edit Price', `admin:edit_prod_price:${p.id}`)
      .text('✏️ Edit Stock', `admin:edit_prod_stock:${p.id}`);

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:toggle_prod:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    const p = await db.getProduct(ctx.match[1]);
    if (p) {
      p.is_active = !p.is_active;
      await db.saveProduct(p);
      await ctx.answerCallbackQuery({ text: `Product is now ${p.is_active ? 'Active' : 'Disabled'}` });
      await ctx.reply(`Product *${p.name}* is now ${p.is_active ? '🟢 Active' : '🔴 Disabled'}.`, { parse_mode: 'Markdown' });
    }
  });

  // Prompt delete product with confirmation
  bot.callbackQuery(/^admin:del_prod:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const p = await db.getProduct(ctx.match[1]);
    if (!p) return ctx.reply('⚠️ Product not found.');

    await ctx.reply(
      `⚠️ *Are you sure you want to delete this product?*\n\n` +
      `Product: *${p.name}* (ID: \`${p.id}\`, Price: ₹${p.price})\n\n` +
      `This will permanently remove it from the database and user catalog.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.confirmDeleteProductInline(p.id)
      }
    );
  });

  // Confirm delete product
  bot.callbackQuery(/^admin:prod_del_confirm:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const productId = ctx.match[1];
    const p = await db.getProduct(productId);
    await db.deleteProduct(productId);

    await ctx.reply(`✅ Product *${p ? p.name : productId}* has been permanently deleted from the database.`, {
      parse_mode: 'Markdown'
    });
  });

  // Edit Product Price / Stock Prompts
  bot.callbackQuery(/^admin:edit_prod_price:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const productId = ctx.match[1];
    stateManager.set(ctx.from.id, { step: 'admin_edit_prod_price', productId });
    await ctx.reply('✍️ Reply with the new price in ₹ (e.g. `499`):');
  });

  bot.callbackQuery(/^admin:edit_prod_stock:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const productId = ctx.match[1];
    stateManager.set(ctx.from.id, { step: 'admin_edit_prod_stock', productId });
    await ctx.reply('✍️ Reply with the stock number (or type `unlimited`):');
  });

  // 3. SERVICES MANAGEMENT
  const listAdminServices = async (ctx) => {
    const services = await db.getServices();
    if (services.length === 0) {
      return ctx.reply('🧑💻 *Manage Services*\n\nNo services found in catalog. Tap *➕ Add Service* below to create one.');
    }

    let msg = `🧑💻 *Services Catalog (${services.length})*\n\n`;
    const kb = new InlineKeyboard();
    services.forEach((s, idx) => {
      const statusIcon = s.is_active ? '🟢' : '🔴';
      msg += `*${idx + 1}. ${s.name}* (₹${s.price})\n` +
        `• Status: ${statusIcon} ${s.is_active ? 'Active' : 'Disabled'} | Delivery: ${s.delivery_time || 'Standard'}\n\n`;
      kb.text(`⚙️ Manage "${s.name.slice(0, 16)}"`, `admin:view_serv:${s.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  };

  bot.hears(/^🧑💻 Services/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    await ctx.reply('🧑💻 *Services Management*\n\nUse the bottom buttons to add or list services:', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminServicesReplyMenu()
    });
    await listAdminServices(ctx);
  });

  bot.hears(/^📋 List Services/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await listAdminServices(ctx);
  });

  bot.hears(/^➕ Add Service/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    stateManager.set(ctx.from.id, { step: 'admin_add_service_name' });
    await ctx.reply(
      '🧑💻 *Add New Service (Step 1/5)*\n\n' +
      'Please reply with the *Name* of the service:',
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'admin:menu')
      }
    );
  });

  bot.callbackQuery(/^admin:view_serv:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const s = await db.getService(ctx.match[1]);
    if (!s) return ctx.reply('⚠️ Service not found.');

    const msg = `🧑💻 *Service: ${s.name}*\n\n` +
      `• *Price:* ₹${s.price}\n` +
      `• *Delivery Time:* ${s.delivery_time || '24-48 Hours'}\n` +
      `• *Status:* ${s.is_active ? '🟢 Active' : '🔴 Disabled'}\n` +
      `• *Requirements:* ${s.requirements || 'None'}\n` +
      `• *Description:* ${s.description}`;

    const kb = new InlineKeyboard()
      .text(s.is_active ? '🔴 Disable' : '🟢 Enable', `admin:toggle_serv:${s.id}`)
      .text('🗑️ Delete Service', `admin:del_serv:${s.id}`)
      .row()
      .text('✏️ Edit Price', `admin:edit_serv_price:${s.id}`);

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:toggle_serv:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    const s = await db.getService(ctx.match[1]);
    if (s) {
      s.is_active = !s.is_active;
      await db.saveService(s);
      await ctx.answerCallbackQuery({ text: `Service is now ${s.is_active ? 'Active' : 'Disabled'}` });
      await ctx.reply(`Service *${s.name}* is now ${s.is_active ? '🟢 Active' : '🔴 Disabled'}.`, { parse_mode: 'Markdown' });
    }
  });

  // Prompt delete service with confirmation
  bot.callbackQuery(/^admin:del_serv:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const s = await db.getService(ctx.match[1]);
    if (!s) return ctx.reply('⚠️ Service not found.');

    await ctx.reply(
      `⚠️ *Are you sure you want to delete this service?*\n\n` +
      `Service: *${s.name}* (ID: \`${s.id}\`, Price: ₹${s.price})\n\n` +
      `This will permanently remove it from the database and user catalog.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.confirmDeleteServiceInline(s.id)
      }
    );
  });

  // Confirm delete service
  bot.callbackQuery(/^admin:srv_del_confirm:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const serviceId = ctx.match[1];
    const s = await db.getService(serviceId);
    await db.deleteService(serviceId);

    await ctx.reply(`✅ Service *${s ? s.name : serviceId}* has been permanently deleted from the database.`, {
      parse_mode: 'Markdown'
    });
  });

  bot.callbackQuery(/^admin:edit_serv_price:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const serviceId = ctx.match[1];
    stateManager.set(ctx.from.id, { step: 'admin_edit_serv_price', serviceId });
    await ctx.reply('✍️ Reply with the new price in ₹ (e.g. `1999`):');
  });

  // 4. FORCE CHANNELS MANAGEMENT
  const listForceChannels = async (ctx) => {
    const channels = await db.getForceChannels();
    if (channels.length === 0) {
      return ctx.reply('📢 *Force Channels*\n\nNo force subscription channels are currently configured. Tap *➕ Add Channel* below to add one.');
    }

    let msg = `📢 *Mandatory Channels (${channels.length})*\n\n`;
    const kb = new InlineKeyboard();
    channels.forEach((ch, idx) => {
      const statusIcon = ch.is_active ? '🟢 Active' : '🔴 Disabled';
      msg += `*${idx + 1}. ${ch.channel_name}*\n` +
        `• ID/Username: \`${ch.channel_id}\`\n` +
        `• Link: ${ch.invite_link}\n` +
        `• Status: ${statusIcon}\n\n`;
      kb.text(`🗑️ Remove "${ch.channel_name.slice(0, 14)}"`, `admin:del_fc:${ch.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  };

  bot.hears(/^📢 Force Channels/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    await ctx.reply('📢 *Force Channel Management*\n\nConfigure mandatory channels that users must join before using the bot:', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminForceChannelsReplyMenu()
    });
    await listForceChannels(ctx);
  });

  bot.hears(/^📢 View Channels/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await listForceChannels(ctx);
  });

  bot.hears(/^➕ Add Channel/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    stateManager.set(ctx.from.id, { step: 'admin_add_channel_id' });
    await ctx.reply(
      '📢 *Add Force Channel (Step 1/3)*\n\n' +
      'Please reply with the *Channel Username or ID* (e.g. `@MyChannel` or `-1001234567890`):\n' +
      '⚠️ Make sure your bot is added as an *Administrator* in the channel.',
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'admin:menu')
      }
    );
  });

  bot.callbackQuery(/^admin:del_fc:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const channelId = ctx.match[1];
    const ch = await db.getForceChannel(channelId);
    await db.deleteForceChannel(channelId);

    await ctx.reply(`✅ Channel *${ch ? ch.channel_name : channelId}* has been removed from mandatory subscription.`, {
      parse_mode: 'Markdown'
    });
  });

  // 5. WITHDRAWALS MANAGEMENT
  bot.hears(/^💸 Withdrawals/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    await ctx.reply('💸 *Withdrawal Management*\n\nReview and approve customer payout requests:', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminWithdrawalsReplyMenu()
    });
  });

  bot.hears(/^⏳ Pending Withdrawals/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const pending = await db.getWithdrawals('pending');
    if (pending.length === 0) {
      return ctx.reply('✅ No pending withdrawal requests found.');
    }

    for (const w of pending.slice(0, 5)) {
      const msg = `💸 *Withdrawal Request #${w.id}*\n\n` +
        `👤 *User:* ${w.user_name} (\`${w.user_telegram_id}\`)\n` +
        `💵 *Amount:* ₹${w.amount}\n` +
        `💳 *Payout Details:* \`${w.payment_details}\`\n` +
        `📅 *Requested:* ${new Date(w.created_at).toLocaleString()}`;

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: keyboards.adminWithdrawalActions(w)
      });
    }
  });

  bot.hears(/^📋 All Withdrawals/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const all = await db.getWithdrawals();
    if (all.length === 0) {
      return ctx.reply('📋 No withdrawal records found.');
    }

    let msg = `📋 *All Withdrawals (${all.length})*\n\n`;
    all.slice(0, 10).forEach(w => {
      const badge = w.status === 'paid' ? '✅ Paid' : (w.status === 'rejected' ? '❌ Rejected' : '⏳ Pending');
      msg += `• *₹${w.amount}* by \`${w.user_telegram_id}\` [${badge}] — ${new Date(w.created_at).toLocaleDateString()}\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.callbackQuery(/^admin:wth_action:(.+):(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const withdrawalId = ctx.match[1];
    const action = ctx.match[2]; // 'paid' or 'reject'
    const status = action === 'paid' ? 'paid' : 'rejected';

    const w = await db.getWithdrawal(withdrawalId);
    if (!w) return ctx.reply('⚠️ Withdrawal not found.');

    await db.updateWithdrawalStatus(withdrawalId, status);

    // Notify customer
    try {
      if (status === 'paid') {
        await bot.api.sendMessage(
          w.user_telegram_id,
          `🎉 *Withdrawal Approved & Paid!*\n\n` +
          `Your payout request of *₹${w.amount}* has been processed.\n` +
          `Payment Details: \`${w.payment_details}\`\n\n` +
          `Thank you for earning with VYRON Business!`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.api.sendMessage(
          w.user_telegram_id,
          `❌ *Withdrawal Update*\n\n` +
          `Your payout request of *₹${w.amount}* was declined by administration.\n` +
          `The funds have been returned to your withdrawable wallet balance.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      console.warn('Failed to notify customer of withdrawal status:', e.message);
    }

    await ctx.reply(`Withdrawal *#${withdrawalId}* marked as *${status.toUpperCase()}*.`, { parse_mode: 'Markdown' });
  });

  // 6. ORDERS MANAGEMENT
  bot.hears(/^📦 Orders/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const orders = await db.getOrders();
    const pendingCount = orders.filter(o => o.status === 'pending').length;

    let msg = `📦 *Order Management (${orders.length})*\n\n` +
      `⏳ Pending: ${pendingCount} | ✅ Completed: ${orders.filter(o => o.status === 'completed').length}\n\n` +
      `Recent orders:`;

    const kb = new InlineKeyboard();
    orders.slice(0, 8).forEach(o => {
      const statusIcon = o.status === 'completed' ? '✅' : (o.status === 'processing' ? '⚙️' : (o.status === 'cancelled' ? '❌' : '⏳'));
      kb.text(`${statusIcon} #${o.order_number} (₹${o.final_amount})`, `admin:view_order:${o.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:orders:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const filter = ctx.match[1] === 'all' ? null : ctx.match[1];
    const orders = await db.getOrders(filter);

    const kb = new InlineKeyboard();
    orders.slice(0, 10).forEach(o => {
      const statusIcon = o.status === 'completed' ? '✅' : (o.status === 'processing' ? '⚙️' : (o.status === 'cancelled' ? '❌' : '⏳'));
      kb.text(`${statusIcon} ${o.order_number} - ₹${o.final_amount}`, `admin:view_order:${o.id}`).row();
    });

    await ctx.reply(
      `📦 *Orders Management (${orders.length})*\nFilter: *${filter || 'ALL'}*\n\nSelect an order to update status:`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^admin:view_order:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const order = await db.getOrder(ctx.match[1]);
    if (!order) return ctx.reply('⚠️ Order not found.');

    const payment = await db.getPaymentByOrder(order.id);

    const msg = `📦 *Order:* \`${order.order_number}\`\n\n` +
      `👤 *Customer:* ${order.user_name} (\`${order.user_telegram_id}\`)\n` +
      `🛍️ *Item:* ${order.item_name} [${order.item_type}]\n` +
      `💵 *Amount:* ₹${order.final_amount}\n` +
      `📊 *Order Status:* ${order.status.toUpperCase()}\n` +
      `💳 *Payment:* ${payment ? `${payment.status.toUpperCase()} (UTR: ${payment.transaction_id || 'Attached'})` : 'No proof submitted'}\n` +
      `📅 *Placed At:* ${new Date(order.created_at).toLocaleString()}\n` +
      (order.requirements ? `\n📝 *Customer Requirements:*\n${order.requirements}\n` : '') +
      (order.delivery_info ? `\n🚚 *Delivery Info:*\n${order.delivery_info}\n` : '');

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminOrderActions(order)
    });
  });

  bot.callbackQuery(/^admin:order_status:(.+):(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const orderId = ctx.match[1];
    const newStatus = ctx.match[2];
    await db.updateOrderStatus(orderId, newStatus);
    const order = await db.getOrder(orderId);

    // If order was completed, award 10% referral commission automatically!
    if (newStatus === 'completed') {
      const comm = await db.recordReferralCommission(order.user_telegram_id, order.id, order.order_number, order.final_amount);
      if (comm) {
        try {
          await bot.api.sendMessage(
            comm.referrerId,
            `🎉 *Referral Purchase Commission!*\n\n` +
            `Your referred customer completed order *#${order.order_number}*.\n` +
            `You earned 10% commission: *₹${comm.commission.toFixed(2)}*! 💰\n` +
            `Withdrawable Balance: *₹${comm.newBalance.toFixed(2)}*`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          console.warn('Could not notify referrer of commission:', e.message);
        }
      }
    }

    // Notify customer
    try {
      const statusNotice = newStatus === 'completed'
        ? `🎉 *Your Order #${order.order_number} has been Completed!*\n\n${order.delivery_info || 'Thank you for your business!'}`
        : (newStatus === 'processing'
          ? `⚙️ *Update:* Your Order \`${order.order_number}\` is now in progress.`
          : `❌ *Update:* Your Order \`${order.order_number}\` was marked as ${newStatus}.`);

      await bot.api.sendMessage(order.user_telegram_id, statusNotice, { parse_mode: 'Markdown' });
    } catch (e) {
      console.warn('Could not notify customer:', e.message);
    }

    await ctx.reply(`✅ Order \`${order.order_number}\` status updated to *${newStatus.toUpperCase()}* and customer notified.`, {
      parse_mode: 'Markdown'
    });
  });

  // 7. PAYMENTS MANAGEMENT
  bot.hears(/^💳 Payments/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const payments = await db.getPayments();
    const pending = payments.filter(p => p.status === 'pending');

    let msg = `💳 *Payment Verification (${payments.length})*\n\n` +
      `⏳ Pending Verification: ${pending.length}\n\n`;

    const kb = new InlineKeyboard();
    payments.slice(0, 8).forEach(p => {
      const badge = p.status === 'approved' ? '✅' : (p.status === 'rejected' ? '❌' : '⏳');
      kb.text(`${badge} ₹${p.amount} (${p.transaction_id || 'Proof'})`, `admin:view_pay:${p.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:view_pay:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const payments = await db.getPayments();
    const p = payments.find(item => item.id === ctx.match[1]);
    if (!p) return ctx.reply('⚠️ Payment record not found.');

    const order = await db.getOrder(p.order_id);
    const msg = `💳 *Payment Review*\n\n` +
      `🆔 *Payment ID:* \`${p.id}\`\n` +
      `📦 *Order:* \`${order ? order.order_number : p.order_id}\`\n` +
      `👤 *Customer ID:* \`${p.user_telegram_id}\`\n` +
      `💵 *Amount:* ₹${p.amount}\n` +
      `🔢 *Transaction ID / UTR:* \`${p.transaction_id || 'Attached Screenshot'}\`\n` +
      `📊 *Status:* ${p.status.toUpperCase()}\n` +
      `📅 *Submitted:* ${new Date(p.created_at).toLocaleString()}`;

    if (p.proof_file_id) {
      try {
        await ctx.replyWithPhoto(p.proof_file_id, {
          caption: `📸 Screenshot for Payment \`${p.id}\` (₹${p.amount})`,
          parse_mode: 'Markdown',
          reply_markup: keyboards.adminPaymentActions(p)
        });
        return;
      } catch (e) {
        console.warn('Error sending payment photo:', e.message);
      }
    }

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboards.adminPaymentActions(p) });
  });

  bot.callbackQuery(/^admin:pay_action:(.+):(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const paymentId = ctx.match[1];
    const action = ctx.match[2];
    const status = action === 'approve' ? 'approved' : 'rejected';

    await db.updatePaymentStatus(paymentId, status);
    const payments = await db.getPayments();
    const p = payments.find(item => item.id === paymentId);

    if (p && status === 'approved') {
      const order = await db.getOrder(p.order_id);
      if (order) {
        const nextStatus = order.item_type === 'product' && order.delivery_info ? 'completed' : 'processing';
        await db.updateOrderStatus(order.id, nextStatus);

        if (nextStatus === 'completed') {
          const comm = await db.recordReferralCommission(order.user_telegram_id, order.id, order.order_number, order.final_amount);
          if (comm) {
            try {
              await bot.api.sendMessage(
                comm.referrerId,
                `🎉 *Referral Purchase Commission!*\n\n` +
                `Your referred customer completed order *#${order.order_number}*.\n` +
                `You earned 10% commission: *₹${comm.commission.toFixed(2)}*! 💰\n` +
                `Updated Balance: *₹${comm.newBalance.toFixed(2)}*`,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              console.warn('Could not notify referrer:', e.message);
            }
          }
        }

        try {
          await bot.api.sendMessage(
            p.user_telegram_id,
            `✅ *Payment Confirmed!*\n\nYour payment of ₹${p.amount} for Order \`${order.order_number}\` has been approved.\n` +
            (nextStatus === 'completed' ? `\n🎉 *Delivery / Access:* ${order.delivery_info}` : `Your order is now being processed!`),
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          console.warn('Failed to notify customer:', e.message);
        }
      }
    }

    await ctx.reply(`Payment *${paymentId}* marked as *${status.toUpperCase()}*.`);
  });

  // 8. USERS MANAGEMENT
  bot.hears(/^👥 Users/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const users = await db.getUsers();
    let msg = `👥 *Registered Customers (${users.length})*\n\n`;
    const kb = new InlineKeyboard();

    users.slice(0, 8).forEach(u => {
      const statusIcon = u.is_blocked ? '🚫 Blocked' : '🟢 Active';
      msg += `• *${u.first_name}* (\`${u.telegram_id}\`) — ${statusIcon}\n`;
      kb.text(u.is_blocked ? `🟢 Unblock ${u.first_name.slice(0, 10)}` : `🚫 Block ${u.first_name.slice(0, 10)}`, `admin:toggle_block:${u.telegram_id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:toggle_block:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const tid = ctx.match[1];
    const u = await db.getUser(tid);
    if (u) {
      const nextBlocked = !u.is_blocked;
      await db.setUserBlocked(tid, nextBlocked);
      await ctx.reply(`User \`${tid}\` is now ${nextBlocked ? '🚫 Blocked' : '🟢 Unblocked'}.`, { parse_mode: 'Markdown' });
    }
  });

  // 9. SUPPORT TICKETS MANAGEMENT
  bot.hears(/^🎫 Support/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const tickets = await db.getTickets();
    const openTickets = tickets.filter(t => t.status === 'open');

    let msg = `🎫 *Support Tickets (${tickets.length})*\n\n` +
      `🟡 Open / Pending Reply: ${openTickets.length}\n\n`;

    const kb = new InlineKeyboard();
    tickets.slice(0, 8).forEach(t => {
      const badge = t.status === 'open' ? '🟡' : (t.status === 'answered' ? '🟢' : '⚪');
      kb.text(`${badge} ${t.ticket_number}: ${t.subject.slice(0, 16)}`, `admin:view_tkt:${t.id}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:view_tkt:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const t = await db.getTicket(ctx.match[1]);
    if (!t) return ctx.reply('⚠️ Ticket not found.');

    let msg = `🎫 *Ticket #${t.ticket_number}*\n` +
      `👤 Customer: ${t.user_name} (\`${t.user_telegram_id}\`)\n` +
      `📋 Subject: ${t.subject}\n` +
      `📊 Status: ${t.status.toUpperCase()}\n\n` +
      `💬 *Conversation History:*\n`;

    (t.messages || []).forEach(m => {
      const sender = m.sender === 'admin' ? '🛡️ Admin' : '👤 Customer';
      msg += `*${sender}:* ${m.text}\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboards.adminTicketActions(t) });
  });

  bot.callbackQuery(/^admin:ticket_reply:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const ticketId = ctx.match[1];
    stateManager.set(ctx.from.id, { step: 'admin_ticket_reply', ticketId });
    await ctx.reply('✍️ Reply to customer: send your response message below:');
  });

  bot.callbackQuery(/^admin:ticket_close:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    await db.updateTicketStatus(ctx.match[1], 'closed');
    await ctx.reply(`Ticket *#${ctx.match[1]}* closed.`);
  });

  // 10. BROADCAST
  bot.hears(/^📢 Broadcast/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    stateManager.set(ctx.from.id, { step: 'admin_broadcast_message' });
    await ctx.reply(
      '📢 *Broadcast Message to All Users*\n\n' +
      'Please reply with the message text or photo with caption you wish to broadcast to all registered bot users:',
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'admin:menu')
      }
    );
  });

  // 11. ANALYTICS
  bot.hears(/^📈 Analytics/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const stats = await db.getDashboardStats();
    const users = await db.getUsers();
    const referrals = await db.getWithdrawals();

    const msg = `📈 *Business Analytics & Metrics*\n\n` +
      `• *Total Registered Users:* ${users.length}\n` +
      `• *Total Orders Created:* ${stats.totalOrders}\n` +
      `• *Completed Orders:* ${stats.completedOrders}\n` +
      `• *Gross Sales:* ₹${stats.totalSales}\n` +
      `• *Total Withdrawal Requests:* ${referrals.length}\n` +
      `• *Active Products:* ${(await db.getProducts(true)).length}\n` +
      `• *Active Services:* ${(await db.getServices(true)).length}\n` +
      `• *Active Force Channels:* ${(await db.getForceChannels(true)).length}`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // 12. ADMIN MANAGEMENT (SUPER ADMIN ONLY)
  bot.hears(/^👑 Admin Management/i, async (ctx) => {
    const { isAdmin, isSuperAdmin } = await checkAdmin(ctx);
    if (!isAdmin || !isSuperAdmin) {
      return ctx.reply('⛔ Only Super Admins can manage administrator privileges.');
    }

    const admins = await db.getAdmins();
    let msg = `👑 *Admin Roles Management (${admins.length})*\n\n`;
    const kb = new InlineKeyboard().text('➕ Add Administrator', 'admin:add_admin:prompt').row();

    admins.forEach(a => {
      msg += `• *${a.username || 'Admin'}* (\`${a.telegram_id}\`) — *${a.role.toUpperCase()}*\n`;
      if (a.role !== 'super_admin') {
        kb.text(`❌ Revoke ${a.username || a.telegram_id}`, `admin:revoke:${a.telegram_id}`).row();
      }
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery('admin:add_admin:prompt', async (ctx) => {
    const { isSuperAdmin } = await checkAdmin(ctx);
    if (!isSuperAdmin) return ctx.answerCallbackQuery({ text: '⛔ Super Admin only', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    stateManager.set(ctx.from.id, { step: 'admin_add_admin_id' });
    await ctx.reply('👑 Reply with the Telegram User ID to grant Admin rights:');
  });

  bot.callbackQuery(/^admin:revoke:(.+)$/, async (ctx) => {
    const { isSuperAdmin } = await checkAdmin(ctx);
    if (!isSuperAdmin) return ctx.answerCallbackQuery({ text: '⛔ Super Admin only', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const targetId = ctx.match[1];
    await db.removeAdmin(targetId);
    await ctx.reply(`Admin permissions revoked for \`${targetId}\`.`, { parse_mode: 'Markdown' });
  });

  // 13. SETTINGS
  bot.hears(/^⚙️ Settings/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const s = await db.getSettings();
    const msg = `⚙️ *Platform Settings*\n\n` +
      `• *UPI ID:* \`${s.upi_id || 'business@upi'}\`\n` +
      `• *Receiver Name:* ${s.receiver_name || 'VYRON Business'}\n` +
      `• *Currency:* ${s.currency || 'INR'}\n` +
      `• *AI Assistant Enabled:* ${s.ai_enabled !== false ? '✅ Yes' : '🔴 No'}\n\n` +
      `Click a button below to update settings:`;

    const kb = new InlineKeyboard()
      .text('✏️ Change UPI ID', 'admin:set_upi')
      .text('✏️ Change Receiver Name', 'admin:set_name')
      .row()
      .text(s.ai_enabled !== false ? '🔴 Disable AI' : '🟢 Enable AI', 'admin:toggle_ai');

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery('admin:set_upi', async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await ctx.answerCallbackQuery().catch(() => {});
    stateManager.set(ctx.from.id, { step: 'admin_set_upi' });
    await ctx.reply('✍️ Send the new UPI ID (e.g. `merchant@upi`):');
  });

  bot.callbackQuery('admin:set_name', async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await ctx.answerCallbackQuery().catch(() => {});
    stateManager.set(ctx.from.id, { step: 'admin_set_name' });
    await ctx.reply('✍️ Send the recipient business name:');
  });

  bot.callbackQuery('admin:toggle_ai', async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const s = await db.getSettings();
    s.ai_enabled = s.ai_enabled === false;
    await db.saveSettings(s);
    await ctx.reply(`AI Assistant is now ${s.ai_enabled !== false ? '🟢 Enabled' : '🔴 Disabled'}.`);
  });

  // 14. EARNINGS / COMMISSIONS OVERVIEW
  bot.hears(/^💰 Earnings/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const withdrawals = await db.getWithdrawals();
    const paidTotal = withdrawals
      .filter(w => w.status === 'paid')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);
    const pendingTotal = withdrawals
      .filter(w => w.status === 'pending')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    const msg = `💰 *Referral & Commission Program Overview*\n\n` +
      `• *Commission Rate:* 10% on all product/service purchases\n` +
      `• *Join Reward:* ₹2.00 per successful referral join\n` +
      `• *Total Paid Out:* ₹${paidTotal.toFixed(2)}\n` +
      `• *Pending Payout Requests:* ₹${pendingTotal.toFixed(2)} (${withdrawals.filter(w => w.status === 'pending').length} requests)\n\n` +
      `Tap *💸 Withdrawals* in the bottom menu to process payout requests.`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // 15. OFFERS & COUPONS MANAGEMENT
  bot.hears(/^🎁 Offers/i, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return;

    const coupons = await db.getCoupons();
    let msg = `🎁 *Coupons & Promo Offers (${coupons.length})*\n\n`;
    const kb = new InlineKeyboard().text('➕ Create New Coupon', 'admin:add_coupon:prompt').row();

    coupons.forEach(c => {
      const discount = c.discount_type === 'percent' ? `${c.discount_value}%` : `₹${c.discount_value}`;
      msg += `• \`${c.code}\`: ${discount} off (Used: ${c.times_used || 0})\n`;
      kb.text(`🗑️ Delete ${c.code}`, `admin:del_coupon:${c.code}`).row();
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery('admin:add_coupon:prompt', async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    stateManager.set(ctx.from.id, { step: 'admin_add_coupon_code' });
    await ctx.reply('🎟️ Reply with the new coupon code (e.g. `SAVE25`):');
  });

  bot.callbackQuery(/^admin:del_coupon:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const code = ctx.match[1];
    await db.deleteCoupon(code);
    await ctx.reply(`Coupon \`${code}\` deleted.`);
  });
}
