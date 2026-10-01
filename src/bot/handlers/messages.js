import { GoogleGenAI } from '@google/genai';
import { InlineKeyboard } from 'grammy';
import { db } from '../../db/index.js';
import { keyboards } from '../keyboards.js';
import { stateManager } from '../state.js';
import { aiService } from '../../ai/index.js';
import { checkAdmin } from './admin.js';

export function registerMessageHandlers(bot) {
  bot.on(['message:text', 'message:photo'], async (ctx) => {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    // Check if user is blocked
    const user = await db.getUser(fromId);
    if (user?.is_blocked) {
      return ctx.reply('🚫 Your account has been suspended by administration.');
    }

    const text = ctx.message.text ? ctx.message.text.trim() : '';
    const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : null;

    // Recognize all native bottom Reply Keyboard buttons
    const isMenuButton = /^(🎛️ Menu|🎛️ Open Menu|🎛️ Collapse Menu|❌ Close Menu|🛍️ Products|🧑💻 Services|💰 Earn Money|💰 My Earnings|💰 Balance|🔗 My Referral Link|👥 My Referrals|💸 Withdraw|📊 Earnings History|ℹ️ How It Works|🎁 Offers|🎁 Active Coupons|📦 My Orders|📦 Orders|🤖 VYRON AI|🤖 AI ASSISTANT|🤖 AI Assistant|👤 My Account|👤 Account|🎫 Support|➕ Create Ticket|📋 My Tickets|ℹ️ About|⚙️ Admin Panel|🔙 Exit AI Assistant|🔙 Exit VYRON AI|🔙 Back|🔙 Back to User Menu|🔙 Back to Admin|📊 Dashboard|🗂️ Products|➕ Add Product|📋 List Products|➕ Add Service|📋 List Services|📢 Force Channels|➕ Add Channel|📢 View Channels|⏳ Pending Withdrawals|📋 All Withdrawals|👑 Admin Management|⚙️ Settings)/i.test(text);
    if (isMenuButton) {
      stateManager.clear(fromId);
      aiService.exitAiSession(fromId);
      return;
    }

    // 1. Check if user is in active VYRON AI conversation mode
    if (aiService.isAiActive(fromId) && text) {
      try {
        await ctx.replyWithChatAction('typing');
        const aiResult = await aiService.generateAiResponse(fromId, text, {
          username: ctx.from.username,
          first_name: ctx.from.first_name
        });

        try {
          return await ctx.reply(aiResult.text, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.aiReplyActions()
          });
        } catch (parseErr) {
          console.warn('Markdown parse failed for AI response, retrying without parse_mode:', parseErr.message);
          return await ctx.reply(aiResult.text, {
            reply_markup: keyboards.aiReplyActions()
          });
        }
      } catch (aiErr) {
        console.error('AI conversation error:', aiErr);
        return ctx.reply('⚠️ I\'m having trouble connecting to the AI service right now. Please try again in a moment.', {
          reply_markup: keyboards.aiReplyActions()
        });
      }
    }

    const state = stateManager.get(fromId);
    if (!state) return; // Regular message without prompt context

    try {
      // 1. Awaiting Coupon Code
      if (state.step === 'awaiting_coupon') {
        stateManager.clear(fromId);
        const coupon = await db.getCoupon(text);

        if (!coupon || !coupon.is_active) {
          return ctx.reply('⚠️ Invalid or expired coupon code.', {
            reply_markup: new InlineKeyboard().text('📦 My Orders', 'user:orders')
          });
        }

        const order = await db.getOrder(state.orderId);
        if (!order || order.status !== 'pending') {
          return ctx.reply('⚠️ Order is no longer pending.');
        }

        let discount = 0;
        if (coupon.discount_type === 'percent') {
          discount = Math.round((Number(order.original_amount) * Number(coupon.discount_value)) / 100);
        } else {
          discount = Number(coupon.discount_value);
        }
        discount = Math.min(discount, Number(order.original_amount));

        order.discount = discount;
        order.final_amount = Number(order.original_amount) - discount;
        await db.createOrder(order);

        coupon.times_used = (coupon.times_used || 0) + 1;
        await db.saveCoupon(coupon);

        const msg = `🎉 *Coupon Applied Successfully!*\n\n` +
          `🎟️ Code: \`${coupon.code}\`\n` +
          `💰 Discount: ₹${discount}\n` +
          `💵 *New Amount Due:* ₹${order.final_amount}\n\n` +
          `Please proceed to submit payment proof:`;

        const kb = new InlineKeyboard()
          .text('💳 Submit Payment Proof', `order:pay:${order.id}`)
          .row()
          .text('📦 View Order', `user:order_detail:${order.id}`);

        return ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
      }

      // 2. Awaiting Service Requirements
      if (state.step === 'awaiting_service_requirements') {
        stateManager.clear(fromId);
        const service = await db.getService(state.serviceId);

        if (!service) {
          return ctx.reply('⚠️ Service not found.');
        }

        const order = await db.createOrder({
          user_telegram_id: fromId,
          user_name: ctx.from.first_name || ctx.from.username || 'Customer',
          item_type: 'service',
          item_id: service.id,
          item_name: service.name,
          original_amount: service.price,
          discount: 0,
          final_amount: service.price,
          status: 'pending',
          requirements: text,
          delivery_info: `Turnaround: ${service.delivery_time || 'Standard'}`
        });

        const settings = await db.getSettings();
        const msg = `✅ *Service Order Created!*\n\n` +
          `🆔 *Order #:* \`${order.order_number}\`\n` +
          `🧑💻 *Service:* ${order.item_name}\n` +
          `💵 *Price:* ₹${order.final_amount}\n` +
          `📝 *Requirements Received:* ${text}\n\n` +
          `💳 *Payment Details:*\n` +
          `• *UPI ID:* \`${settings.upi_id || 'business@upi'}\`\n` +
          `• *Recipient:* ${settings.receiver_name || 'VYRON Business'}\n\n` +
          `Please submit your payment proof to begin work:`;

        return ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.orderActions(order)
        });
      }

      // 3. Awaiting Payment Proof
      if (state.step === 'awaiting_payment_proof') {
        stateManager.clear(fromId);
        const order = await db.getOrder(state.orderId);

        if (!order) {
          return ctx.reply('⚠️ Order not found.');
        }

        const payment = await db.createPayment({
          order_id: order.id,
          user_telegram_id: fromId,
          transaction_id: text || 'Photo Attachment',
          proof_file_id: photo ? photo.file_id : '',
          status: 'pending',
          amount: order.final_amount
        });

        // Notify Admins
        const admins = await db.getAdmins();
        for (const admin of admins) {
          try {
            await bot.api.sendMessage(
              admin.telegram_id,
              `🔔 *New Payment Proof Received!*\n\n` +
              `📦 *Order:* \`${order.order_number}\` (${order.item_name})\n` +
              `👤 *Customer:* ${order.user_name} (\`${fromId}\`)\n` +
              `💵 *Amount:* ₹${payment.amount}\n` +
              `🔢 *UTR / Txn ID:* \`${payment.transaction_id}\``,
              {
                parse_mode: 'Markdown',
                reply_markup: new InlineKeyboard().text('🔍 Review Payment', `admin:view_pay:${payment.id}`)
              }
            );
          } catch (e) {
            console.warn('Could not notify admin of payment proof:', e.message);
          }
        }

        return ctx.reply(
          `✅ *Payment Proof Received!*\n\n` +
          `Order \`${order.order_number}\` is now pending admin verification. You will be notified automatically once approved.`,
          { parse_mode: 'Markdown' }
        );
      }

      // 4. Awaiting Support Ticket Subject
      if (state.step === 'awaiting_ticket_subject') {
        stateManager.set(fromId, { step: 'awaiting_ticket_message', subject: text });
        return ctx.reply(
          `📝 *Subject:* ${text}\n\n` +
          `✍️ Now please describe your issue or question in detail:`,
          {
            parse_mode: 'Markdown',
            reply_markup: new InlineKeyboard().text('❌ Cancel', 'user:support')
          }
        );
      }

      // 5. Awaiting Support Ticket Initial Message
      if (state.step === 'awaiting_ticket_message') {
        stateManager.clear(fromId);
        const ticket = await db.createSupportTicket({
          user_telegram_id: fromId,
          user_name: ctx.from.first_name || ctx.from.username || 'Customer',
          subject: state.subject,
          messages: [
            { sender: 'user', text, timestamp: new Date().toISOString() }
          ]
        });

        // Notify admins
        const admins = await db.getAdmins();
        for (const admin of admins) {
          try {
            await bot.api.sendMessage(
              admin.telegram_id,
              `🎫 *New Support Ticket #${ticket.ticket_number}*\n\n` +
              `👤 *User:* ${ticket.user_name} (\`${fromId}\`)\n` +
              `📋 *Subject:* ${ticket.subject}\n` +
              `💬 *Message:* ${text}`,
              {
                parse_mode: 'Markdown',
                reply_markup: new InlineKeyboard().text('💬 Reply to Ticket', `admin:view_tkt:${ticket.id}`)
              }
            );
          } catch (e) {
            console.warn('Could not notify admin of ticket:', e.message);
          }
        }

        return ctx.reply(
          `✅ *Support Ticket Created!*\n\n` +
          `Ticket Number: \`${ticket.ticket_number}\`\n` +
          `Our support team has been alerted and will reply shortly.`,
          { parse_mode: 'Markdown' }
        );
      }

      // 6. Awaiting User Ticket Reply
      if (state.step === 'awaiting_ticket_reply') {
        stateManager.clear(fromId);
        await db.addTicketMessage(state.ticketId, 'user', text);
        const ticket = await db.getTicket(state.ticketId);

        const admins = await db.getAdmins();
        for (const admin of admins) {
          try {
            await bot.api.sendMessage(
              admin.telegram_id,
              `💬 *Customer replied to Ticket \`${ticket?.ticket_number}\`:*\n\n${text}`,
              {
                parse_mode: 'Markdown',
                reply_markup: new InlineKeyboard().text('🎫 View Ticket', `admin:view_tkt:${state.ticketId}`)
              }
            );
          } catch (e) {
            console.warn('Could not notify admin of ticket reply:', e.message);
          }
        }

        return ctx.reply('✅ Reply sent to support team.');
      }

      // 7. Awaiting Withdrawal Amount
      if (state.step === 'awaiting_withdrawal_amount') {
        const amt = parseFloat(text);
        if (isNaN(amt) || amt < 50) {
          return ctx.reply('⚠️ Minimum withdrawal amount is ₹50.00. Please enter a valid amount:');
        }
        if (amt > state.maxAmount) {
          return ctx.reply(`⚠️ Amount exceeds your withdrawable balance of ₹${state.maxAmount.toFixed(2)}. Please enter a smaller amount:`);
        }

        stateManager.set(fromId, { step: 'awaiting_withdrawal_details', amount: amt });
        return ctx.reply(
          `💵 *Withdrawal Amount:* ₹${amt.toFixed(2)}\n\n` +
          `✍️ Please reply with your payout details (e.g. *UPI ID: yourname@upi* or *Bank Account & IFSC*):`,
          { parse_mode: 'Markdown' }
        );
      }

      // 8. Awaiting Withdrawal Details
      if (state.step === 'awaiting_withdrawal_details') {
        stateManager.clear(fromId);
        try {
          const w = await db.createWithdrawal(fromId, ctx.from.first_name, state.amount, text);

          // Alert admins of new payout request
          const admins = await db.getAdmins();
          for (const admin of admins) {
            try {
              await bot.api.sendMessage(
                admin.telegram_id,
                `🔔 *New Withdrawal Request!*\n\n` +
                `👤 *User:* ${w.user_name} (\`${fromId}\`)\n` +
                `💵 *Amount:* ₹${w.amount.toFixed(2)}\n` +
                `💳 *Payout Details:* \`${w.payment_details}\``,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              console.warn('Could not alert admin of withdrawal:', e.message);
            }
          }

          return ctx.reply(
            `✅ *Withdrawal Request Submitted!*\n\n` +
            `💵 *Amount:* ₹${w.amount.toFixed(2)}\n` +
            `💳 *Details:* \`${w.payment_details}\`\n` +
            `⏳ *Status:* Pending Admin Review\n\n` +
            `Our team will verify and transfer your payout promptly.`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          return ctx.reply(`❌ ${err.message}`);
        }
      }

      // ==========================================
      // ADMIN STEPS
      // ==========================================
      const { isAdmin, isSuperAdmin } = await checkAdmin(ctx);
      if (!isAdmin) return;

      // Admin Add Product Steps
      if (state.step === 'admin_add_product_name') {
        stateManager.set(fromId, { step: 'admin_add_product_price', name: text });
        return ctx.reply(`🛍️ *Product Name:* ${text}\n\nNow send the *Price* in numbers (e.g. \`499\`):`, {
          parse_mode: 'Markdown'
        });
      }

      if (state.step === 'admin_add_product_price') {
        const price = parseFloat(text);
        if (isNaN(price)) return ctx.reply('⚠️ Please send a valid numeric price (e.g. 499):');
        stateManager.set(fromId, { ...state, step: 'admin_add_product_type', price });

        const kb = new InlineKeyboard()
          .text('💾 Digital Product', 'admin:set_prod_type:digital')
          .text('📦 Physical Product', 'admin:set_prod_type:physical');
        return ctx.reply(`💰 *Price:* ₹${price}\n\nSelect product type:`, { reply_markup: kb });
      }

      if (state.step === 'admin_add_product_desc') {
        stateManager.set(fromId, { ...state, step: 'admin_add_product_delivery', description: text });
        return ctx.reply('🚚 *Delivery Information:*\n\nSend delivery instructions (e.g. download link or shipping info):');
      }

      if (state.step === 'admin_add_product_delivery') {
        stateManager.clear(fromId);
        const product = await db.saveProduct({
          name: state.name,
          price: state.price,
          type: state.type || 'digital',
          description: state.description,
          delivery_info: text,
          stock: 100,
          is_unlimited: state.type === 'digital',
          is_active: true
        });

        return ctx.reply(`✅ *Product Created Successfully!*\n\n🛍️ *${product.name}* (₹${product.price}) is now live in your catalog.`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Add Service Steps
      if (state.step === 'admin_add_service_name') {
        stateManager.set(fromId, { step: 'admin_add_service_price', name: text });
        return ctx.reply(`🧑💻 *Service Name:* ${text}\n\nSend the *Price* in numbers (e.g. \`1499\`):`);
      }

      if (state.step === 'admin_add_service_price') {
        const price = parseFloat(text);
        if (isNaN(price)) return ctx.reply('⚠️ Please send a valid numeric price:');
        stateManager.set(fromId, { ...state, step: 'admin_add_service_time', price });
        return ctx.reply('⏱️ *Delivery / Turnaround Time:*\n\nSend estimated time (e.g. `24-48 Hours`):');
      }

      if (state.step === 'admin_add_service_time') {
        stateManager.set(fromId, { ...state, step: 'admin_add_service_desc', deliveryTime: text });
        return ctx.reply('📝 *Description & Requirements:*\n\nSend service details and what you need from the customer:');
      }

      if (state.step === 'admin_add_service_desc') {
        stateManager.clear(fromId);
        const service = await db.saveService({
          name: state.name,
          price: state.price,
          delivery_time: state.deliveryTime,
          description: text,
          requirements: 'Customer will describe specifications upon order.',
          is_active: true
        });

        return ctx.reply(`✅ *Service Added!*\n\n💼 *${service.name}* (₹${service.price}) is now bookable.`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Edit Product Price
      if (state.step === 'admin_edit_prod_price') {
        stateManager.clear(fromId);
        const price = parseFloat(text);
        if (isNaN(price)) return ctx.reply('⚠️ Invalid price.');
        const p = await db.getProduct(state.productId);
        if (p) {
          p.price = price;
          await db.saveProduct(p);
          return ctx.reply(`✅ Product *${p.name}* price updated to *₹${price}*.`, { parse_mode: 'Markdown' });
        }
      }

      // Admin Edit Product Stock
      if (state.step === 'admin_edit_prod_stock') {
        stateManager.clear(fromId);
        const p = await db.getProduct(state.productId);
        if (p) {
          if (/unlimited/i.test(text)) {
            p.is_unlimited = true;
          } else {
            p.is_unlimited = false;
            p.stock = parseInt(text, 10) || 0;
          }
          await db.saveProduct(p);
          return ctx.reply(`✅ Product *${p.name}* stock updated.`, { parse_mode: 'Markdown' });
        }
      }

      // Admin Edit Service Price
      if (state.step === 'admin_edit_serv_price') {
        stateManager.clear(fromId);
        const price = parseFloat(text);
        if (isNaN(price)) return ctx.reply('⚠️ Invalid price.');
        const s = await db.getService(state.serviceId);
        if (s) {
          s.price = price;
          await db.saveService(s);
          return ctx.reply(`✅ Service *${s.name}* price updated to *₹${price}*.`, { parse_mode: 'Markdown' });
        }
      }

      // Admin Force Channel Steps
      if (state.step === 'admin_add_channel_id') {
        stateManager.set(fromId, { step: 'admin_add_channel_name', channel_id: text });
        return ctx.reply('📢 *Channel Name:*\n\nSend the display name for this channel (e.g. `VYRON Official Updates`):');
      }

      if (state.step === 'admin_add_channel_name') {
        stateManager.set(fromId, { ...state, step: 'admin_add_channel_link', channel_name: text });
        return ctx.reply('🔗 *Channel Invite Link:*\n\nSend the link (e.g. `https://t.me/MyChannel`):');
      }

      if (state.step === 'admin_add_channel_link') {
        stateManager.clear(fromId);
        const ch = await db.saveForceChannel({
          channel_id: state.channel_id,
          channel_name: state.channel_name,
          invite_link: text,
          is_active: true
        });

        return ctx.reply(`✅ *Force Channel Added!*\n\n📢 *${ch.channel_name}* (\`${ch.channel_id}\`) is now required for bot access.`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Broadcast Flow
      if (state.step === 'admin_broadcast_message') {
        stateManager.clear(fromId);
        const users = await db.getUsers();
        let sentCount = 0;
        let failCount = 0;

        await ctx.reply(`⏳ *Dispatching broadcast to ${users.length} users...*`);

        for (const u of users) {
          try {
            if (photo) {
              await bot.api.sendPhoto(u.telegram_id, photo.file_id, {
                caption: `📢 *Announcement:*\n\n${ctx.message.caption || ''}`,
                parse_mode: 'Markdown'
              });
            } else {
              await bot.api.sendMessage(u.telegram_id, `📢 *Announcement:*\n\n${text}`, {
                parse_mode: 'Markdown'
              });
            }
            sentCount++;
          } catch (e) {
            failCount++;
          }
          await new Promise(res => setTimeout(res, 40));
        }

        return ctx.reply(`✅ *Broadcast Complete!*\n\n• Delivered: *${sentCount}*\n• Failed/Blocked: *${failCount}*`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Ticket Reply
      if (state.step === 'admin_ticket_reply') {
        stateManager.clear(fromId);
        await db.addTicketMessage(state.ticketId, 'admin', text);
        const ticket = await db.getTicket(state.ticketId);

        try {
          await bot.api.sendMessage(
            ticket.user_telegram_id,
            `🛡️ *Support Reply for Ticket \`${ticket.ticket_number}\`:*\n\n${text}`,
            {
              parse_mode: 'Markdown',
              reply_markup: new InlineKeyboard().text('💬 View & Reply', `ticket:view:${ticket.id}`)
            }
          );
        } catch (e) {
          console.warn('Failed to send ticket reply to user:', e.message);
        }

        return ctx.reply(`✅ Response sent to customer.`);
      }

      // Super Admin Add Admin by ID
      if (state.step === 'admin_add_admin_id' && isSuperAdmin) {
        stateManager.clear(fromId);
        const targetId = text.replace(/[^0-9]/g, '');
        if (!targetId) return ctx.reply('⚠️ Invalid Telegram ID.');

        await db.saveAdmin({
          telegram_id: targetId,
          username: `Admin_${targetId.slice(-4)}`,
          role: 'admin',
          permissions: ['catalog', 'orders', 'payments', 'support', 'broadcast'],
          added_at: new Date().toISOString(),
          added_by: String(fromId)
        });

        return ctx.reply(`✅ User \`${targetId}\` promoted to Administrator.`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Add Coupon Code
      if (state.step === 'admin_add_coupon_code') {
        stateManager.set(fromId, { step: 'admin_add_coupon_value', code: text.toUpperCase() });
        return ctx.reply(`🎟️ *Code:* \`${text.toUpperCase()}\`\n\nSend the discount percentage (e.g. \`20\` for 20% off):`);
      }

      if (state.step === 'admin_add_coupon_value') {
        const val = parseFloat(text);
        if (isNaN(val)) return ctx.reply('⚠️ Please send a valid number:');
        stateManager.clear(fromId);

        const coupon = await db.saveCoupon({
          code: state.code,
          description: `${val}% Discount Promo`,
          discount_type: 'percent',
          discount_value: val,
          is_active: true
        });

        return ctx.reply(`✅ *Coupon \`${coupon.code}\` Created!*\n\nCustomers can now apply this code at checkout.`, {
          parse_mode: 'Markdown'
        });
      }

      // Admin Settings: UPI & Name
      if (state.step === 'admin_set_upi') {
        stateManager.clear(fromId);
        const s = await db.getSettings();
        s.upi_id = text;
        await db.saveSettings(s);
        return ctx.reply(`✅ Business UPI ID updated to \`${text}\`.`, { parse_mode: 'Markdown' });
      }

      if (state.step === 'admin_set_name') {
        stateManager.clear(fromId);
        const s = await db.getSettings();
        s.receiver_name = text;
        await db.saveSettings(s);
        return ctx.reply(`✅ Receiver business name updated to *${text}*.`, { parse_mode: 'Markdown' });
      }

    } catch (err) {
      console.error('Error handling message state:', err);
      return ctx.reply('⚠️ An error occurred processing your request. Please try again.');
    }
  });

  // Callback to set product type during admin add product flow
  bot.callbackQuery(/^admin:set_prod_type:(.+)$/, async (ctx) => {
    const { isAdmin } = await checkAdmin(ctx);
    if (!isAdmin) return ctx.answerCallbackQuery({ text: '⛔ Access Denied', show_alert: true });
    await ctx.answerCallbackQuery().catch(() => {});

    const type = ctx.match[1];
    const state = stateManager.get(ctx.from.id);
    if (!state) return;

    stateManager.set(ctx.from.id, { ...state, step: 'admin_add_product_desc', type });
    await ctx.reply(`📦 Type set to *${type.toUpperCase()}*.\n\nNow send the *Description* of the product:`, {
      parse_mode: 'Markdown'
    });
  });
}
