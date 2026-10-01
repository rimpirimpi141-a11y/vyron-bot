import { InlineKeyboard } from 'grammy';
import { db } from '../../db/index.js';
import { keyboards } from '../keyboards.js';
import { stateManager } from '../state.js';
import { checkAdmin } from './admin.js';
import { aiService } from '../../ai/index.js';

/**
 * Check if the user has joined all required force subscription channels
 */
export async function checkForceChannels(ctx, bot) {
  const channels = await db.getForceChannels(true);
  if (!channels || channels.length === 0) return true;

  const notJoined = [];
  for (const ch of channels) {
    try {
      const member = await bot.api.getChatMember(ch.channel_id, ctx.from.id);
      if (['left', 'kicked'].includes(member.status)) {
        notJoined.push(ch);
      }
    } catch (err) {
      // If bot is not in channel or check fails, log warning but don't block
      console.warn(`Force channel check warning for ${ch.channel_id}:`, err.message);
    }
  }

  if (notJoined.length > 0) {
    await ctx.reply(
      '📢 *Mandatory Channel Subscription*\n\n' +
      'To access VYRON Business Bot, please join our official channel(s) below. Once joined, tap *🔄 I Have Joined* to unlock the bot:',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.forceChannelJoinInline(notJoined)
      }
    );
    return false;
  }

  return true;
}

export function registerUserHandlers(bot) {
  // Shared helper to enter dedicated VYRON AI conversation mode
  const enterVyronAi = async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'ai_mode');
    aiService.startAiSession(ctx.from.id);

    const welcomeMsg = `🤖 *Welcome to VYRON Business AI*\n\n` +
      `I'm your AI business assistant. Ask me anything about our products, services, offers, orders, earning opportunities, or general business questions.\n\n` +
      `How can I help you?`;

    await ctx.reply(welcomeMsg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.aiReplyMenu()
    });
  };

  // Shared helper to exit VYRON AI mode
  const exitVyronAi = async (ctx) => {
    aiService.exitAiSession(ctx.from.id);
    stateManager.clear(ctx.from.id);
    stateManager.resetNav(ctx.from.id, 'full_menu');
    const admin = await db.getAdmin(ctx.from.id);

    await ctx.reply(
      '👋 *Exited AI Assistant*\n\nReturned to the main menu.',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fullMenu(Boolean(admin))
      }
    );
  };

  // /start command
  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    // Check Force Channels first
    const hasJoined = await checkForceChannels(ctx, bot);
    if (!hasJoined) return;

    // Parse referral code: /start ref_12345 or /start 12345
    let referrerId = null;
    const match = (ctx.match || '').trim();
    if (match.startsWith('ref_')) {
      referrerId = match.replace('ref_', '');
    } else if (/^\d+$/.test(match)) {
      referrerId = match;
    }

    const existingUser = await db.getUser(from.id);
    const isNewUser = !existingUser;

    // Upsert user in database
    await db.upsertUser({
      telegram_id: from.id,
      username: from.username || '',
      first_name: from.first_name || 'User'
    });

    // Award ₹2 referral join reward if applicable
    if (isNewUser && referrerId && String(referrerId) !== String(from.id)) {
      const rewardResult = await db.recordReferralJoin(from.id, referrerId, from.first_name);
      if (rewardResult) {
        try {
          await bot.api.sendMessage(
            rewardResult.referrerId,
            `🎉 *New Referral Joined!*\n\n` +
            `*${from.first_name}* joined using your invite link.\n` +
            `You earned *₹${rewardResult.reward.toFixed(2)}*! 💰\n` +
            `Withdrawable Balance: *₹${rewardResult.newBalance.toFixed(2)}*`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          console.warn('Could not notify referrer of join reward:', e.message);
        }
      }
    }

    await db.trackEvent('user_start', { telegram_id: from.id });

    // Reset navigation stack to full_menu so user immediately sees all main options
    const admin = await db.getAdmin(from.id);
    const isAdmin = Boolean(admin);
    stateManager.resetNav(from.id, 'full_menu');

    const welcomeMsg = `✨ *Welcome to VYRON Business Bot*, ${from.first_name}!\n\n` +
      `Your all-in-one center for business products, professional services, affiliate earnings, and customer support.\n\n` +
      `👇 Choose an option from the menu below or chat with our *🤖 AI ASSISTANT* anytime!`;

    await ctx.reply(welcomeMsg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.fullMenu(isAdmin)
    });
  });

  // Force Channel Check Callback
  bot.callbackQuery('user:check_joined', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const hasJoined = await checkForceChannels(ctx, bot);
    if (hasJoined) {
      const admin = await db.getAdmin(ctx.from.id);
      stateManager.resetNav(ctx.from.id, 'full_menu');
      await ctx.reply(
        '✅ *Thank you for joining!* Access granted to VYRON Business Bot.\n\n👇 Choose an option from the menu below:',
        {
          parse_mode: 'Markdown',
          reply_markup: keyboards.fullMenu(Boolean(admin))
        }
      );
    }
  });

  // /menu command
  bot.command('menu', async (ctx) => {
    const admin = await db.getAdmin(ctx.from?.id);
    stateManager.pushNav(ctx.from.id, 'full_menu');
    await ctx.reply('🎛️ *VYRON Main Menu*\n\nPlease choose a category from the bottom keyboard:', {
      parse_mode: 'Markdown',
      reply_markup: keyboards.fullMenu(Boolean(admin))
    });
  });

  // ==========================================
  // TOGGLE CONTROLS (EXPAND & COLLAPSE)
  // ==========================================

  // Open Full Menu
  bot.hears(/^(🎛️ Menu|🎛️ Open Menu)/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'full_menu');
    const admin = await db.getAdmin(ctx.from.id);
    await ctx.reply(
      '🎛️ *VYRON Main Menu*\n\nExplore our digital products, business services, earning opportunities, or support:',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fullMenu(Boolean(admin))
      }
    );
  });

  // Close / Collapse Full Menu back to 4-button menu
  bot.hears(/^(❌ Close Menu|🎛️ Collapse Menu)/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.resetNav(ctx.from.id, 'four_button');
    await ctx.reply(
      '✨ *Menu Collapsed*\n\nQuick toggles are ready below. Tap *🎛️ Menu* whenever you want the full catalog.',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fourButtonMenu()
      }
    );
  });

  // ==========================================
  // NAVIGATION: PRODUCTS (CHAT CONTENT + INLINE)
  // ==========================================

  const showProductsList = async (ctx) => {
    const products = await db.getProducts(true);

    if (products.length === 0) {
      return ctx.reply('🛍️ *Products Catalog*\n\nNo products are currently available in the catalog. Please check back soon!', {
        parse_mode: 'Markdown'
      });
    }

    let text = '🛍️ *Available Products*\n\n';
    products.forEach((p, idx) => {
      const stockText = p.is_unlimited ? '⚡ Unlimited Stock' : (p.stock > 0 ? `📦 In Stock: ${p.stock}` : '❌ Out of Stock');
      text += `*${idx + 1}. ${p.name}*\n💰 Price: *₹${p.price}* | ${stockText}\n\n`;
    });
    text += 'Tap a product below to view full details and place your order:';

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.productListInline(products)
    });
  };

  bot.hears(/^🛍️ Products/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    await showProductsList(ctx);
  });

  bot.callbackQuery('user:products:list', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showProductsList(ctx);
  });

  bot.callbackQuery(/^user:product:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const productId = ctx.match[1];
    const product = await db.getProduct(productId);

    if (!product || !product.is_active) {
      return ctx.reply('⚠️ Product is no longer available in the catalog.', {
        parse_mode: 'Markdown'
      });
    }

    const stockText = product.is_unlimited ? '⚡ Unlimited Available' : `${product.stock} units available`;
    const typeText = product.type === 'digital' ? '💾 Digital Delivery' : '📦 Physical Shipping';

    const msg = `🛍️ *${product.name}*\n\n` +
      `💰 *Price:* ₹${product.price}\n` +
      `📊 *Availability:* ${stockText}\n` +
      `📦 *Format:* ${typeText}\n` +
      (product.delivery_info ? `🚚 *Delivery Info:* ${product.delivery_info}\n` : '') +
      `\n📝 *Description:*\n${product.description}\n\n` +
      `Ready to purchase? Click *Buy Now* below:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.productDetailInline(product)
    });
  });

  // Start Product Order Flow
  bot.callbackQuery(/^order:start:product:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const productId = ctx.match[1];
    const product = await db.getProduct(productId);

    if (!product || (!product.is_unlimited && product.stock <= 0)) {
      return ctx.reply('⚠️ Sorry, this item is currently out of stock.');
    }

    const order = await db.createOrder({
      user_telegram_id: ctx.from.id,
      user_name: ctx.from.first_name || ctx.from.username || 'Customer',
      item_type: 'product',
      item_id: product.id,
      item_name: product.name,
      original_amount: product.price,
      discount: 0,
      final_amount: product.price,
      status: 'pending',
      delivery_info: product.delivery_info || ''
    });

    if (!product.is_unlimited && product.stock > 0) {
      product.stock -= 1;
      await db.saveProduct(product);
    }

    await db.trackEvent('product_order_created', { order_id: order.id, product_id: product.id });

    const settings = await db.getSettings();
    const msg = `✅ *Order Created!*\n\n` +
      `🆔 *Order ID:* \`${order.order_number}\`\n` +
      `🛍️ *Item:* ${order.item_name}\n` +
      `💵 *Amount Due:* ₹${order.final_amount}\n` +
      `⏳ *Status:* Pending Payment\n\n` +
      `💳 *Payment Details:*\n` +
      `• *UPI ID:* \`${settings.upi_id || 'business@upi'}\`\n` +
      `• *Recipient:* ${settings.receiver_name || 'VYRON Business'}\n\n` +
      `📝 *Instructions:*\n${settings.payment_instructions || 'Transfer payment and tap Submit Payment Proof below.'}`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.orderActions(order)
    });
  });

  // ==========================================
  // NAVIGATION: SERVICES (CHAT CONTENT + INLINE)
  // ==========================================

  const showServicesList = async (ctx) => {
    const services = await db.getServices(true);

    if (services.length === 0) {
      return ctx.reply('🧑💻 *Services Catalog*\n\nNo services are currently open for booking. Check back soon!', {
        parse_mode: 'Markdown'
      });
    }

    let text = '🧑💻 *Services Catalog*\n\n';
    services.forEach((s, idx) => {
      text += `*${idx + 1}. ${s.name}*\n💰 Price: *₹${s.price}* | ⏱️ Turnaround: ${s.delivery_time || 'Standard'}\n\n`;
    });
    text += 'Tap a service below to view deliverables, requirements, and book:';

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.serviceListInline(services)
    });
  };

  bot.hears(/^🧑💻 Services/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    await showServicesList(ctx);
  });

  bot.callbackQuery('user:services:list', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showServicesList(ctx);
  });

  bot.callbackQuery(/^user:service:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const serviceId = ctx.match[1];
    const service = await db.getService(serviceId);

    if (!service || !service.is_active) {
      return ctx.reply('⚠️ Service is not currently available.', {
        parse_mode: 'Markdown'
      });
    }

    const msg = `🧑💻 *${service.name}*\n\n` +
      `💰 *Price:* ₹${service.price}\n` +
      `⏱️ *Delivery Time:* ${service.delivery_time || '24-48 Hours'}\n\n` +
      `📋 *Required from you:*\n${service.requirements || 'Details specified upon order.'}\n\n` +
      `📝 *Description:*\n${service.description}\n\n` +
      `Tap *Order Service* below to book:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.serviceDetailInline(service)
    });
  });

  bot.callbackQuery(/^order:start:service:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const serviceId = ctx.match[1];
    const service = await db.getService(serviceId);

    if (!service) {
      return ctx.reply('⚠️ Service not found.');
    }

    stateManager.set(ctx.from.id, { step: 'awaiting_service_requirements', serviceId });

    await ctx.reply(
      `📋 *Service Order Requirements*\n\n` +
      `You are booking: *${service.name}* (₹${service.price})\n\n` +
      `*Required Info:*\n${service.requirements || 'Please describe your request in detail.'}\n\n` +
      `✍️ *Please reply directly with your specifications and requirements:*`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:services:list')
      }
    );
  });

  // ==========================================
  // NAVIGATION: REFER & EARN SYSTEM
  // ==========================================

  bot.hears(/^(💰 Earn Money|💰 My Earnings)/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'earn_menu');

    const msg = `💰 *Refer & Earn with VYRON*\n\n` +
      `Earn *10% commission* on every product/service purchase by your referrals, and earn *₹2 per successful join*!\n\n` +
      `• Share your link with friends or channels\n` +
      `• Earn ₹2 immediately when they start the bot\n` +
      `• Earn 10% lifetime commission on every purchase\n` +
      `• Request payout directly to your UPI/Bank anytime!\n\n` +
      `👇 Use the bottom menu buttons to check your balance, get your link, or withdraw:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.earnReplyMenu()
    });
  });

  bot.hears(/^💰 Balance/i, async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    const walletBalance = Number(user?.wallet_balance || 0).toFixed(2);
    const withdrawable = Number(user?.withdrawable_balance || 0).toFixed(2);
    const totalEarned = Number(user?.total_earned || 0).toFixed(2);
    const referralCount = Number(user?.referral_count || 0);

    const msg = `💰 *Your Earning Balance*\n\n` +
      `💵 *Withdrawable Balance:* ₹${withdrawable}\n` +
      `📊 *Total Earned:* ₹${totalEarned}\n` +
      `👥 *Referred Users:* ${referralCount}\n\n` +
      `💡 *Minimum Withdrawal:* ₹50.00\n` +
      `Tap *💸 Withdraw* in the bottom menu to request payout.`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears(/^🔗 My Referral Link/i, async (ctx) => {
    const me = await bot.api.getMe();
    const botUsername = me.username || 'VyronBusinessBot';
    const link = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;

    const msg = `🔗 *Your Personal Referral Link*\n\n` +
      `\`${link}\`\n\n` +
      `💰 *How It Works:*\n` +
      `1. Copy and share your link with friends, groups, or channels.\n` +
      `2. Earn *₹2 instantly* when a new user starts the bot using your link.\n` +
      `3. Earn *10% commission* on every product and service they purchase, forever!`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears(/^👥 My Referrals/i, async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    const referrals = await db.getReferrals(ctx.from.id);

    let msg = `👥 *My Referrals* (Total: ${user?.referral_count || 0})\n\n`;
    if (referrals.length === 0) {
      msg += `You haven't referred any users yet. Tap *🔗 My Referral Link* to start earning!`;
    } else {
      referrals.slice(0, 10).forEach((r, idx) => {
        const typeLabel = r.type === 'join' ? '₹2.00 Join Reward' : `₹${r.amount} (10% Commission on #${r.order_number || ''})`;
        msg += `${idx + 1}. User \`${r.referred_id}\` — *${typeLabel}*\n`;
      });
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears(/^📊 Earnings History/i, async (ctx) => {
    const referrals = await db.getReferrals(ctx.from.id);
    const withdrawals = await db.getWithdrawals();
    const myWithdrawals = withdrawals.filter(w => String(w.user_telegram_id) === String(ctx.from.id));

    let msg = `📊 *Earnings & Payout History*\n\n`;
    if (referrals.length === 0 && myWithdrawals.length === 0) {
      msg += `No earnings or payout records found yet. Share your referral link to begin!`;
    } else {
      if (referrals.length > 0) {
        msg += `*Recent Credits:*\n`;
        referrals.slice(0, 5).forEach(r => {
          msg += `• +₹${r.amount} (${r.type === 'join' ? 'Join' : '10% Commission'}) on ${new Date(r.created_at).toLocaleDateString()}\n`;
        });
        msg += `\n`;
      }
      if (myWithdrawals.length > 0) {
        msg += `*Withdrawal Requests:*\n`;
        myWithdrawals.slice(0, 5).forEach(w => {
          const badge = w.status === 'paid' ? '✅ Paid' : (w.status === 'rejected' ? '❌ Rejected' : '⏳ Pending');
          msg += `• -₹${w.amount} [${badge}] — ${new Date(w.created_at).toLocaleDateString()}\n`;
        });
      }
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears(/^ℹ️ How It Works/i, async (ctx) => {
    const msg = `ℹ️ *Refer & Earn System Guide*\n\n` +
      `*1. Join Reward (₹2.00)*\n` +
      `Whenever a new customer clicks your referral link and starts the bot, your wallet is immediately credited with ₹2.00.\n\n` +
      `*2. Purchase Commission (10%)*\n` +
      `Whenever any of your referred users purchases a digital product or books a service, you automatically receive 10% of their payment.\n\n` +
      `*3. Payouts*\n` +
      `Once your withdrawable balance reaches ₹50, you can request a withdrawal to UPI, Paytm, or Bank transfer. Our admin reviews and pays out promptly.\n\n` +
      `*Fair Usage Rules:*\n` +
      `Self-referrals and automated fake accounts are detected and barred.`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears(/^💸 Withdraw/i, async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    const balance = Number(user?.withdrawable_balance || 0);

    if (balance < 50) {
      return ctx.reply(
        `⚠️ *Insufficient Withdrawable Balance*\n\n` +
        `Your current withdrawable balance is *₹${balance.toFixed(2)}*.\n` +
        `The minimum withdrawal limit is *₹50.00*.\n\n` +
        `Share your referral link to earn more rewards!`,
        { parse_mode: 'Markdown' }
      );
    }

    stateManager.set(ctx.from.id, { step: 'awaiting_withdrawal_amount', maxAmount: balance });

    await ctx.reply(
      `💸 *Request Payout*\n\n` +
      `Available to withdraw: *₹${balance.toFixed(2)}*\n\n` +
      `✍️ Please enter the amount you wish to withdraw (minimum ₹50, maximum ₹${balance.toFixed(2)}):`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:cancel_withdraw')
      }
    );
  });

  bot.callbackQuery('user:cancel_withdraw', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    stateManager.clear(ctx.from.id);
    await ctx.reply('Withdrawal request cancelled.');
  });

  // ==========================================
  // NAVIGATION: SUPPORT (BOTTOM REPLY KEYBOARD)
  // ==========================================

  bot.hears(/^🎫 Support/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'support_menu');

    const msg = `🎫 *Customer Support Center*\n\n` +
      `Our team is here to assist you with order delivery, payment verification, custom bot setups, or general inquiries.\n\n` +
      `Use the bottom menu to submit a ticket or review your past conversations:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.supportReplyMenu()
    });
  });

  bot.hears(/^➕ Create Ticket/i, async (ctx) => {
    stateManager.set(ctx.from.id, { step: 'awaiting_ticket_subject' });
    await ctx.reply(
      `📝 *Create Support Ticket*\n\n` +
      `Please reply with the *subject or reason* for your support request (e.g., _"Question about Order #1234"_ or _"Setup assistance"_):`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:support')
      }
    );
  });

  bot.hears(/^📋 My Tickets/i, async (ctx) => {
    const tickets = await db.getUserTickets(ctx.from.id);

    if (tickets.length === 0) {
      return ctx.reply('📋 *My Support Tickets*\n\nYou currently have no open or past support tickets.');
    }

    let msg = `📋 *My Support Tickets*\n\n`;
    const kb = new InlineKeyboard();
    tickets.slice(0, 8).forEach(t => {
      const badge = t.status === 'open' ? '🟡 Open' : (t.status === 'answered' ? '🟢 Answered' : '⚪ Closed');
      msg += `• *${t.ticket_number}* [${badge}]: ${t.subject}\n`;
      kb.text(`💬 ${t.ticket_number}`, `ticket:view:${t.id}`).row();
    });

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: kb
    });
  });

  // ==========================================
  // NAVIGATION: MY ACCOUNT & ORDERS
  // ==========================================

  bot.hears(/^(👤 My Account|👤 Account)/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'account_menu');

    const user = await db.getUser(ctx.from.id);
    const orders = await db.getUserOrders(ctx.from.id);
    const completedCount = orders.filter(o => o.status === 'completed').length;
    const totalSpent = orders
      .filter(o => o.status === 'completed')
      .reduce((sum, o) => sum + Number(o.final_amount || 0), 0);

    const msg = `👤 *My Account Profile*\n\n` +
      `🆔 *Telegram ID:* \`${ctx.from.id}\`\n` +
      `👤 *Name:* ${ctx.from.first_name} ${ctx.from.last_name || ''}\n` +
      (ctx.from.username ? `🌐 *Username:* @${ctx.from.username}\n` : '') +
      `📦 *Total Orders:* ${orders.length} (Completed: ${completedCount})\n` +
      `💰 *Total Purchases:* ₹${totalSpent}\n` +
      `💵 *Wallet Balance:* ₹${Number(user?.withdrawable_balance || 0).toFixed(2)}\n` +
      `👥 *Referrals:* ${user?.referral_count || 0}\n` +
      `📅 *Joined:* ${user ? new Date(user.joined_at).toLocaleDateString() : 'Today'}`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.accountReplyMenu()
    });
  });

  bot.hears(/^(📦 My Orders|📦 Orders)/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    const orders = await db.getUserOrders(ctx.from.id);

    if (orders.length === 0) {
      return ctx.reply('📦 *My Orders*\n\nYou haven\'t placed any orders yet. Tap *🛍️ Products* to browse our catalog!');
    }

    let msg = `📦 *My Order History*\n\n`;
    const kb = new InlineKeyboard();
    orders.slice(0, 10).forEach(o => {
      const statusIcon = o.status === 'completed' ? '✅' : (o.status === 'processing' ? '⚙️' : (o.status === 'cancelled' ? '❌' : '⏳'));
      msg += `${statusIcon} *#${o.order_number}* — ${o.item_name} (₹${o.final_amount}) [${o.status.toUpperCase()}]\n`;
      kb.text(`${statusIcon} #${o.order_number}`, `user:order_detail:${o.id}`).row();
    });

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: kb
    });
  });

  // ==========================================
  // NAVIGATION: OFFERS
  // ==========================================

  bot.hears(/^🎁 Offers/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    stateManager.pushNav(ctx.from.id, 'offers_menu');

    const coupons = await db.getCoupons(true);

    if (coupons.length === 0) {
      return ctx.reply('🎁 *Active Offers*\n\nNo public discount coupons are active right now. Check back soon!', {
        reply_markup: keyboards.offersReplyMenu()
      });
    }

    let msg = '🎁 *Current Offers & Discount Coupons*\n\nApply these codes at checkout to save on products & services:\n\n';
    coupons.forEach(c => {
      const discountText = c.discount_type === 'percent' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`;
      msg += `🎟️ Code: \`${c.code}\`\n• *Discount:* ${discountText}\n• *Details:* ${c.description || 'Valid on purchases'}\n\n`;
    });

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.offersReplyMenu()
    });
  });

  bot.hears(/^🎁 Active Coupons/i, async (ctx) => {
    const coupons = await db.getCoupons(true);
    if (coupons.length === 0) {
      return ctx.reply('🎁 No public discount coupons are currently active.');
    }
    let msg = '🎟️ *Active Discount Coupons:*\n\n';
    coupons.forEach(c => {
      const discount = c.discount_type === 'percent' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`;
      msg += `• \`${c.code}\`: ${discount} — ${c.description || 'Applicable on orders'}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ==========================================
  // NAVIGATION: ABOUT
  // ==========================================

  bot.hears(/^ℹ️ About/i, async (ctx) => {
    const settings = await db.getSettings();
    const about = settings.about_text || 'VYRON Business Automation & E-Commerce Platform.';
    await ctx.reply(`ℹ️ *About VYRON Business*\n\n${about}`, { parse_mode: 'Markdown' });
  });

  // ==========================================
  // NAVIGATION: AI ASSISTANT (VYRON AI)
  // ==========================================

  bot.hears(/^(🤖 AI ASSISTANT|🤖 AI Assistant|🤖 VYRON AI)/i, async (ctx) => {
    await enterVyronAi(ctx);
  });

  bot.command('ai', async (ctx) => {
    await enterVyronAi(ctx);
  });

  bot.hears(/^(🔙 Exit AI Assistant|🔙 Exit VYRON AI)/i, async (ctx) => {
    await exitVyronAi(ctx);
  });

  bot.callbackQuery('ai:exit', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await exitVyronAi(ctx);
  });

  // ==========================================
  // NAVIGATION: BACK BUTTON (STACK NAVIGATION)
  // ==========================================

  bot.hears(/^🔙 Back$/i, async (ctx) => {
    stateManager.clear(ctx.from.id);
    const prev = stateManager.popNav(ctx.from.id);
    const admin = await db.getAdmin(ctx.from.id);
    const isAdmin = Boolean(admin);

    if (prev === 'full_menu') {
      await ctx.reply('🎛️ *VYRON Main Menu*', {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fullMenu(isAdmin)
      });
    } else {
      await ctx.reply('✨ *Main Screen*', {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fourButtonMenu()
      });
    }
  });

  // View specific order detail
  bot.callbackQuery(/^user:order_detail:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const orderId = ctx.match[1];
    const order = await db.getOrder(orderId);

    if (!order) {
      return ctx.reply('⚠️ Order not found.');
    }

    const payment = await db.getPaymentByOrder(order.id);
    const statusIcon = order.status === 'completed' ? '✅ Completed' : (order.status === 'processing' ? '⚙️ Processing' : (order.status === 'cancelled' ? '❌ Cancelled' : '⏳ Pending Payment'));

    let msg = `📦 *Order #${order.order_number}*\n\n` +
      `🛍️ *Item:* ${order.item_name} (${order.item_type})\n` +
      `💰 *Amount:* ₹${order.final_amount}\n` +
      `📊 *Status:* ${statusIcon}\n` +
      `📅 *Date:* ${new Date(order.created_at).toLocaleString()}\n`;

    if (payment) {
      msg += `\n💳 *Payment Proof:* Submitted (${payment.status.toUpperCase()})\n` +
        `• Txn / UTR: \`${payment.transaction_id || 'Attached Screenshot'}\`\n`;
    }

    if (order.status === 'completed' && order.delivery_info) {
      msg += `\n🎉 *Delivery Details / Access:*\n${order.delivery_info}\n`;
    }

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.orderActions(order)
    });
  });

  // Cancel Order
  bot.callbackQuery(/^order:cancel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const orderId = ctx.match[1];
    const order = await db.getOrder(orderId);

    if (!order || order.status !== 'pending') {
      return ctx.reply('⚠️ Only pending orders can be cancelled.');
    }

    await db.updateOrderStatus(order.id, 'cancelled');
    await ctx.reply(`❌ Order *#${order.order_number}* has been cancelled.`, { parse_mode: 'Markdown' });
  });

  // Submit Payment Proof Action
  bot.callbackQuery(/^order:pay:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const orderId = ctx.match[1];
    const order = await db.getOrder(orderId);

    if (!order) return ctx.reply('⚠️ Order not found.');

    stateManager.set(ctx.from.id, { step: 'awaiting_payment_proof', orderId: order.id });

    const settings = await db.getSettings();
    const msg = `💳 *Submit Payment Proof*\n\n` +
      `Order: *#${order.order_number}* (₹${order.final_amount})\n\n` +
      `• *UPI ID:* \`${settings.upi_id || 'business@upi'}\`\n` +
      `• *Name:* ${settings.receiver_name || 'VYRON Business'}\n\n` +
      `📸 *Please upload your transaction screenshot or reply with the 12-digit UTR/Txn ID:*`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:orders')
    });
  });

  // Support Ticket View
  bot.callbackQuery(/^ticket:view:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const ticketId = ctx.match[1];
    const ticket = await db.getTicket(ticketId);

    if (!ticket) return ctx.reply('⚠️ Ticket not found.');

    let msg = `🎫 *Support Ticket #${ticket.ticket_number}*\n\n` +
      `📋 *Subject:* ${ticket.subject}\n` +
      `📊 *Status:* ${ticket.status.toUpperCase()}\n\n` +
      `💬 *Conversation:*\n`;

    (ticket.messages || []).forEach(m => {
      const from = m.sender === 'admin' ? '🛡️ Support' : '👤 You';
      msg += `*${from}:* ${m.text}\n\n`;
    });

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.userTicketActions(ticket)
    });
  });

  // User Ticket Reply Prompt
  bot.callbackQuery(/^ticket:user_reply:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const ticketId = ctx.match[1];
    stateManager.set(ctx.from.id, { step: 'awaiting_ticket_reply', ticketId });

    await ctx.reply('💬 *Reply to Support*\n\nPlease send your response message below:', {
      reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:support')
    });
  });
}
