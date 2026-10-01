import { InlineKeyboard } from 'grammy';

export const keyboards = {
  // 1. The 4 Small Toggle/Menu-Control Buttons (Collapsed State)
  // Exactly 4 buttons at the bottom with official Telegram style fields
  // - primary = blue
  // - success = green
  // - danger = red
  fourButtonMenu() {
    return {
      keyboard: [
        [
          { text: '🎛️ Menu', style: 'primary' },
          { text: '🤖 AI ASSISTANT', style: 'success' }
        ],
        [
          { text: '📦 Orders', style: 'primary' },
          { text: '👤 Account', style: 'primary' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // 2. Full Main Menu (Default on /start and when Expanded)
  // Recommended layout:
  // Row 1: 🛍️ Products (primary)      🧑💻 Services (primary)
  // Row 2: 💰 Earn Money (success)     🎁 Offers (success)
  // Row 3: 📦 Orders (primary)         👤 Account (primary)
  // Row 4: 🎫 Support (primary)        ℹ️ About (primary)
  // Row 5: 🤖 AI ASSISTANT (success, full-width dedicated row)
  // Row 6 (if admin): ⚙️ Admin Panel (danger)
  // Row 7: ❌ Close Menu (danger)
  fullMenu(isAdmin = false) {
    const keyboard = [
      [
        { text: '🛍️ Products', style: 'primary' },
        { text: '🧑💻 Services', style: 'primary' }
      ],
      [
        { text: '💰 Earn Money', style: 'success' },
        { text: '🎁 Offers', style: 'success' }
      ],
      [
        { text: '📦 Orders', style: 'primary' },
        { text: '👤 Account', style: 'primary' }
      ],
      [
        { text: '🎫 Support', style: 'primary' },
        { text: 'ℹ️ About', style: 'primary' }
      ],
      [
        { text: '🤖 AI ASSISTANT', style: 'success' }
      ]
    ];

    if (isAdmin) {
      keyboard.push([
        { text: '⚙️ Admin Panel', style: 'danger' }
      ]);
    }

    keyboard.push([
      { text: '❌ Close Menu', style: 'danger' }
    ]);

    return {
      keyboard,
      resize_keyboard: true
    };
  },

  // Backward compatibility aliases for handlers expecting replyMenu
  replyMenu(isAdmin = false) {
    return this.fullMenu(isAdmin);
  },

  persistentReplyMenu(isAdmin = false) {
    return this.fullMenu(isAdmin);
  },

  // 3. Support Reply Keyboard (Bottom Navigation)
  supportReplyMenu() {
    return {
      keyboard: [
        [
          { text: '➕ Create Ticket', style: 'success' },
          { text: '📋 My Tickets', style: 'primary' }
        ],
        [
          { text: '🔙 Back', style: 'primary' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // 4. Earn Money / Refer & Earn Reply Keyboard (Bottom Navigation)
  earnReplyMenu() {
    return {
      keyboard: [
        [
          { text: '💰 Balance', style: 'success' },
          { text: '🔗 My Referral Link', style: 'primary' }
        ],
        [
          { text: '👥 My Referrals', style: 'primary' },
          { text: '💸 Withdraw', style: 'success' }
        ],
        [
          { text: '📊 Earnings History', style: 'primary' },
          { text: 'ℹ️ How It Works', style: 'primary' }
        ],
        [
          { text: '🔙 Back', style: 'primary' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // 5. My Account Reply Keyboard (Bottom Navigation)
  accountReplyMenu() {
    return {
      keyboard: [
        [
          { text: '📦 My Orders', style: 'primary' },
          { text: '🎫 Support Tickets', style: 'primary' }
        ],
        [
          { text: '💰 My Earnings', style: 'success' },
          { text: '🔙 Back', style: 'primary' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // 6. Offers Reply Keyboard (Bottom Navigation)
  offersReplyMenu() {
    return {
      keyboard: [
        [
          { text: '🎁 Active Coupons', style: 'success' }
        ],
        [
          { text: '🔙 Back', style: 'primary' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // 7. Dedicated AI Assistant Mode Reply Keyboard
  aiReplyMenu() {
    return {
      keyboard: [
        [
          { text: '🔙 Exit AI Assistant', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  aiAssistantMenu() {
    return this.aiReplyMenu();
  },

  aiReplyActions() {
    return {
      inline_keyboard: [
        [ { text: '🔙 Exit AI Assistant', callback_data: 'ai:exit', style: 'danger' } ]
      ]
    };
  },

  // 8. Admin Panel Reply Keyboard (Bottom Navigation)
  adminReplyMenu(isSuperAdmin = false) {
    const keyboard = [
      [
        { text: '📊 Dashboard', style: 'primary' },
        { text: '🗂️ Products', style: 'primary' },
        { text: '🧑💻 Services', style: 'primary' }
      ],
      [
        { text: '💰 Earnings', style: 'success' },
        { text: '🎁 Offers', style: 'success' },
        { text: '📦 Orders', style: 'primary' }
      ],
      [
        { text: '💳 Payments', style: 'primary' },
        { text: '👥 Users', style: 'primary' },
        { text: '🎫 Support', style: 'primary' }
      ],
      [
        { text: '📢 Broadcast', style: 'primary' },
        { text: '📈 Analytics', style: 'primary' },
        { text: '📢 Force Channels', style: 'primary' }
      ]
    ];

    if (isSuperAdmin) {
      keyboard.push([
        { text: '👑 Admin Management', style: 'danger' },
        { text: '💸 Withdrawals', style: 'success' }
      ]);
    } else {
      keyboard.push([
        { text: '💸 Withdrawals', style: 'success' }
      ]);
    }

    keyboard.push([
      { text: '⚙️ Settings', style: 'primary' },
      { text: '🔙 Back to User Menu', style: 'danger' }
    ]);

    return {
      keyboard,
      resize_keyboard: true
    };
  },

  adminProductsReplyMenu() {
    return {
      keyboard: [
        [
          { text: '➕ Add Product', style: 'success' },
          { text: '📋 List Products', style: 'primary' }
        ],
        [
          { text: '🔙 Back to Admin', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  adminServicesReplyMenu() {
    return {
      keyboard: [
        [
          { text: '➕ Add Service', style: 'success' },
          { text: '📋 List Services', style: 'primary' }
        ],
        [
          { text: '🔙 Back to Admin', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  adminForceChannelsReplyMenu() {
    return {
      keyboard: [
        [
          { text: '➕ Add Channel', style: 'success' },
          { text: '📢 View Channels', style: 'primary' }
        ],
        [
          { text: '🔙 Back to Admin', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  adminWithdrawalsReplyMenu() {
    return {
      keyboard: [
        [
          { text: '⏳ Pending Withdrawals', style: 'primary' },
          { text: '📋 All Withdrawals', style: 'primary' }
        ],
        [
          { text: '🔙 Back to Admin', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  // --- DYNAMIC CONTENT INLINE KEYBOARDS (Inside Chat Only) ---

  // Products List in Chat
  productListInline(products) {
    const inline_keyboard = [];
    products.forEach(p => {
      const stockBadge = !p.is_unlimited && p.stock <= 0 ? ' [Out of Stock]' : '';
      inline_keyboard.push([
        { text: `🛍️ ${p.name} - ₹${p.price}${stockBadge}`, callback_data: `user:product:${p.id}`, style: 'primary' }
      ]);
    });
    return { inline_keyboard };
  },

  // Product View Details
  productDetailInline(product) {
    const isOutOfStock = !product.is_unlimited && product.stock <= 0;
    const inline_keyboard = [];

    if (isOutOfStock) {
      inline_keyboard.push([
        { text: '⚠️ Currently Out of Stock', callback_data: 'noop', style: 'danger' }
      ]);
    } else {
      inline_keyboard.push([
        { text: `🛒 Buy Now (₹${product.price})`, callback_data: `order:start:product:${product.id}`, style: 'success' }
      ]);
    }

    inline_keyboard.push([
      { text: '🔙 Back to Products', callback_data: 'user:products:list', style: 'primary' }
    ]);

    return { inline_keyboard };
  },

  // Services List in Chat
  serviceListInline(services) {
    const inline_keyboard = [];
    services.forEach(s => {
      inline_keyboard.push([
        { text: `🧑💻 ${s.name} - ₹${s.price}`, callback_data: `user:service:${s.id}`, style: 'primary' }
      ]);
    });
    return { inline_keyboard };
  },

  // Service View Details
  serviceDetailInline(service) {
    return {
      inline_keyboard: [
        [
          { text: `📩 Order Service (₹${service.price})`, callback_data: `order:start:service:${service.id}`, style: 'success' }
        ],
        [
          { text: '🔙 Back to Services', callback_data: 'user:services:list', style: 'primary' }
        ]
      ]
    };
  },

  // Delete Confirmations (Admin)
  confirmDeleteProductInline(productId) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Delete Product', callback_data: `admin:prod_del_confirm:${productId}`, style: 'danger' },
          { text: '❌ Cancel', callback_data: 'admin:products:0', style: 'primary' }
        ]
      ]
    };
  },

  confirmDeleteServiceInline(serviceId) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Delete Service', callback_data: `admin:srv_del_confirm:${serviceId}`, style: 'danger' },
          { text: '❌ Cancel', callback_data: 'admin:services:0', style: 'primary' }
        ]
      ]
    };
  },

  earningView(opportunity) {
    return {
      inline_keyboard: [
        [ { text: '🔗 Get Referral Link', callback_data: 'earn:get_link', style: 'success' } ],
        [ { text: '🔙 Back to Menu', callback_data: 'user:menu', style: 'primary' } ]
      ]
    };
  },

  // Force Channel Check (Join Links + Verify Button)
  forceChannelJoinInline(channels) {
    const inline_keyboard = [];
    channels.forEach(ch => {
      inline_keyboard.push([
        { text: `📢 Join ${ch.channel_name}`, url: ch.invite_link }
      ]);
    });
    inline_keyboard.push([
      { text: '🔄 I Have Joined', callback_data: 'user:check_joined', style: 'success' }
    ]);
    return { inline_keyboard };
  },

  // Order Details Actions
  orderActions(order) {
    const inline_keyboard = [];
    if (order.status === 'pending') {
      inline_keyboard.push([
        { text: '💳 Submit Payment Proof 📸', callback_data: `order:pay:${order.id}`, style: 'success' }
      ]);
      inline_keyboard.push([
        { text: '❌ Cancel Order', callback_data: `order:cancel:${order.id}`, style: 'danger' }
      ]);
    }
    return { inline_keyboard };
  },

  // Support Ticket Actions
  userTicketActions(ticket) {
    const inline_keyboard = [];
    if (ticket.status !== 'closed') {
      inline_keyboard.push([
        { text: '💬 Send Reply', callback_data: `ticket:user_reply:${ticket.id}`, style: 'primary' }
      ]);
    }
    return { inline_keyboard };
  },

  // Admin Withdrawal Actions
  adminWithdrawalActions(withdrawal) {
    const inline_keyboard = [];
    if (withdrawal.status === 'pending') {
      inline_keyboard.push([
        { text: '✅ Approve & Mark Paid', callback_data: `admin:wth_action:${withdrawal.id}:paid`, style: 'success' },
        { text: '❌ Reject & Refund', callback_data: `admin:wth_action:${withdrawal.id}:reject`, style: 'danger' }
      ]);
    }
    return { inline_keyboard };
  },

  // Admin Payment Actions
  adminPaymentActions(payment) {
    const inline_keyboard = [];
    if (payment.status === 'pending') {
      inline_keyboard.push([
        { text: '✅ Approve Payment', callback_data: `admin:pay_action:${payment.id}:approve`, style: 'success' },
        { text: '❌ Reject Payment', callback_data: `admin:pay_action:${payment.id}:reject`, style: 'danger' }
      ]);
    }
    inline_keyboard.push([
      { text: '📦 View Order', callback_data: `admin:view_order:${payment.order_id}`, style: 'primary' }
    ]);
    return { inline_keyboard };
  },

  // Admin Order Actions
  adminOrderActions(order) {
    const inline_keyboard = [];
    if (order.status === 'pending') {
      inline_keyboard.push([
        { text: '⚙️ Mark Processing', callback_data: `admin:order_status:${order.id}:processing`, style: 'primary' },
        { text: '✅ Complete Order', callback_data: `admin:order_status:${order.id}:completed`, style: 'success' }
      ]);
      inline_keyboard.push([
        { text: '❌ Cancel Order', callback_data: `admin:order_status:${order.id}:cancelled`, style: 'danger' }
      ]);
    } else if (order.status === 'processing') {
      inline_keyboard.push([
        { text: '✅ Complete Order', callback_data: `admin:order_status:${order.id}:completed`, style: 'success' },
        { text: '❌ Cancel Order', callback_data: `admin:order_status:${order.id}:cancelled`, style: 'danger' }
      ]);
    }
    inline_keyboard.push([
      { text: '💬 Contact Customer', callback_data: `admin:msg_user:${order.user_telegram_id}`, style: 'primary' }
    ]);
    return { inline_keyboard };
  },

  // Admin Ticket Actions
  adminTicketActions(ticket) {
    const inline_keyboard = [];
    if (ticket.status !== 'closed') {
      inline_keyboard.push([
        { text: '💬 Reply to Customer', callback_data: `admin:ticket_reply:${ticket.id}`, style: 'primary' },
        { text: '🔒 Close Ticket', callback_data: `admin:ticket_close:${ticket.id}`, style: 'danger' }
      ]);
    }
    return { inline_keyboard };
  },

  // Fallback inline main menu if ever referenced
  mainMenu(isAdmin = false) {
    const inline_keyboard = [
      [
        { text: '🛍️ Products', callback_data: 'user:products:list', style: 'primary' },
        { text: '🧑💻 Services', callback_data: 'user:services:list', style: 'primary' }
      ],
      [
        { text: '💰 Earn Money', callback_data: 'user:earnings:info', style: 'success' },
        { text: '🎁 Offers', callback_data: 'user:offers', style: 'success' }
      ],
      [
        { text: '📦 My Orders', callback_data: 'user:orders', style: 'primary' },
        { text: '👤 My Account', callback_data: 'user:account', style: 'primary' }
      ],
      [
        { text: '🤖 AI ASSISTANT', callback_data: 'user:ai', style: 'success' }
      ],
      [
        { text: '🎫 Support', callback_data: 'user:support', style: 'primary' },
        { text: 'ℹ️ About', callback_data: 'user:about', style: 'primary' }
      ]
    ];

    if (isAdmin) {
      inline_keyboard.push([
        { text: '⚙️ Admin Panel', callback_data: 'admin:menu', style: 'danger' }
      ]);
    }

    return { inline_keyboard };
  }
};
