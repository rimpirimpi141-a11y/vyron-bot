import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';

class AiService {
  constructor() {
    this.sessions = new Map();
    this.SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    this.MAX_HISTORY_TURNS = 10; // Keep last 10 messages (5 user + 5 model turns)
  }

  /**
   * Check if user is currently in active AI conversation mode
   */
  isAiActive(telegramId) {
    const key = String(telegramId);
    const session = this.sessions.get(key);
    if (!session || !session.active) return false;

    // Check expiration
    if (Date.now() - session.lastActive > this.SESSION_TIMEOUT_MS) {
      this.exitAiSession(key);
      return false;
    }
    return true;
  }

  /**
   * Start or resume AI conversation session
   */
  startAiSession(telegramId) {
    const key = String(telegramId);
    const existing = this.sessions.get(key);
    this.sessions.set(key, {
      active: true,
      lastActive: Date.now(),
      history: existing?.history || []
    });
  }

  /**
   * Exit AI conversation session cleanly
   */
  exitAiSession(telegramId) {
    const key = String(telegramId);
    const session = this.sessions.get(key);
    if (session) {
      session.active = false;
      session.lastActive = Date.now();
    }
  }

  /**
   * Clear session history entirely
   */
  clearSession(telegramId) {
    this.sessions.delete(String(telegramId));
  }

  /**
   * Generate an intelligent, grounded response using Gemini
   */
  async generateAiResponse(telegramId, userMessage, userContext = {}) {
    const key = String(telegramId);

    // 1. Verify Server-Side Gemini API Key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        text: '⚠️ *AI Configuration Missing*\n\n' +
          '`GEMINI_API_KEY` is not configured on the server environment. ' +
          'Please set the `GEMINI_API_KEY` environment secret to activate VYRON Business AI.',
        error: 'MISSING_API_KEY'
      };
    }

    // 2. Check if AI feature is administratively enabled
    const settings = await db.getSettings();
    if (settings && settings.ai_enabled === false) {
      return {
        text: 'ℹ️ *AI Assistant Unavailable*\n\n' +
          'The VYRON Business AI Assistant is temporarily paused by the administration. ' +
          'You can browse our catalog in 🛍️ Products or reach out directly via 🎫 Support.',
        error: 'AI_DISABLED'
      };
    }

    // 3. Retrieve Live Database State (Ground Truth)
    const [products, services, opps, coupons, userOrders] = await Promise.all([
      db.getProducts(true),
      db.getServices(true),
      db.getEarningOpportunities(true),
      db.getCoupons(true),
      db.getUserOrders(key)
    ]);

    // Format Database Context
    const productsContext = products.map(p => {
      const stock = p.is_unlimited ? 'Unlimited' : `${p.stock} in stock`;
      return `• [Product #${p.id}] "${p.name}" - Price: ₹${p.price} (${p.type}) | Stock: ${stock} | Description: ${p.description} | Delivery: ${p.delivery_info || 'Instant/Standard'}`;
    }).join('\n') || 'None currently active.';

    const servicesContext = services.map(s => {
      return `• [Service #${s.id}] "${s.name}" - Price: ₹${s.price} | Description: ${s.description}`;
    }).join('\n') || 'None currently active.';

    const oppsContext = opps.map(o => {
      return `• [Earning Program #${o.id}] "${o.name}" - Reward: ${o.reward_info} | How to Earn: ${o.how_to_earn} | Rules: ${o.terms_conditions || 'Follow fair terms.'}`;
    }).join('\n') || 'None currently active.';

    const couponsContext = coupons.map(c => {
      const discount = c.discount_type === 'percent' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`;
      return `• Coupon Code: "${c.code}" (${discount}) - ${c.description || 'Valid on purchases'}`;
    }).join('\n') || 'No active public coupon codes.';

    const ordersContext = userOrders.map(o => {
      return `• Order #${o.order_number}: "${o.item_name}" (${o.item_type}) | Amount: ₹${o.final_amount} | Status: ${o.status.toUpperCase()} | Created: ${new Date(o.created_at).toLocaleDateString()}`;
    }).join('\n') || 'This customer currently has no orders placed.';

    // 4. Construct System Instruction with VYRON Business AI Personality & Anti-Hallucination Rules
    const systemInstruction = `You are "VYRON Business AI", the intelligent business assistant of the VYRON Business Bot on Telegram.

━━━━━━━━━━━━━━━━━━━━
PERSONALITY & IDENTITY:
- Name: 🤖 VYRON Business AI
- Role: An intelligent, versatile business and support assistant. You can converse freely on ANY topic: general business ideas, Telegram channel creation & growth, bot development, digital marketing, advertising copy, technology, coding, educational queries, startup planning, or everyday questions.
- Language: Answer naturally in the same language the user speaks (English, Hindi, Hinglish, etc.).
- Tone: Friendly, professional, helpful, natural, concise, and suitable for Telegram.
- Style: Use clean formatting (bold headers, bullet points, clean paragraphs). Use emojis naturally, but do not overload every sentence.
- IDENTITY RULE: Identify yourself as "VYRON Business AI". Do NOT say "I am Gemini" or "I am a Google AI" or "I am a language model" unless the user explicitly asks about the underlying AI provider.

━━━━━━━━━━━━━━━━━━━━
BOT BUSINESS STRUCTURE & CONTEXT:
The VYRON Business Bot contains:
• 🛍️ Products: Digital goods, tools, e-books, etc.
• 🧑‍💻 Services: Custom bot setups, web development, automation, etc.
• 💰 Earn Money: Refer & earn affiliate program (completely separate from products/services!).
• 🎁 Offers: Active coupon codes and special discounts.
• 📦 Orders: User order history and status tracking.
• 🎫 Support: Helpdesk ticket creation and customer support.

━━━━━━━━━━━━━━━━━━━━
VERIFIED DATABASE RECORDS (LIVE GROUND TRUTH):
[ACTIVE PRODUCTS CATALOG]:
${productsContext}

[ACTIVE SERVICES CATALOG]:
${servicesContext}

[VERIFIED EARNING OPPORTUNITIES & REFERRAL SYSTEM]:
${oppsContext}
• Refer & Earn Program: Users earn 10% commission on every product/service purchase by their referrals, plus ₹2 per valid successful referred join.

[ACTIVE SPECIAL OFFERS & COUPONS]:
${couponsContext}

[AUTHENTICATED CUSTOMER'S ORDERS]:
${ordersContext}

[BUSINESS INFO]:
${settings.about_text || 'VYRON Business Automation & E-Commerce Platform.'}

━━━━━━━━━━━━━━━━━━━━
CRITICAL SAFETY & INTEGRITY RULES:
1. GENERAL QUESTIONS: When the user asks general questions (e.g. "Mujhe Telegram channel banana hai", "Bot kaise banate hain?", "Online store marketing ideas", coding, life advice), answer thoroughly, practically, and naturally WITHOUT forcing the user back into the VYRON catalog.
2. VYRON-SPECIFIC INQUIRIES: When the user asks about VYRON's actual products, services, offers, earning programs, or their own orders:
   - Use ONLY the verified database records above.
   - ZERO HALLUCINATION: NEVER invent prices, stock, delivery times, orders, payment confirmations, or earning reward amounts that are not in the records above.
   - STRICT EARNING SEPARATION: Earning opportunities are programs where users EARN money (10% purchase commission + ₹2 join reward). NEVER describe an earning opportunity as a product purchase.
3. CUSTOMER ORDERS: Only report order statuses that appear in [AUTHENTICATED CUSTOMER'S ORDERS]. If the customer has no orders, state clearly that no orders are on file.
4. UNAVAILABLE INFORMATION: If a requested product or service is not in the database, honestly inform them that it is currently unavailable or suggest contacting 🎫 Support.`;

    // 5. Build Multi-Turn History
    let session = this.sessions.get(key);
    if (!session) {
      session = { active: true, lastActive: Date.now(), history: [] };
      this.sessions.set(key, session);
    }
    session.lastActive = Date.now();

    // Prepare contents array with past messages + current message
    const recentHistory = (session.history || []).slice(-this.MAX_HISTORY_TURNS);
    const contents = recentHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // 6. Call Gemini API with Resilience Fallback
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });

    const candidateModels = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
    let replyText = null;
    let lastError = null;

    for (const model of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
            topP: 0.95
          }
        });

        if (response && response.text) {
          replyText = response.text.trim();
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[AiService] Model ${model} failed, trying fallback:`, err.message);
      }
    }

    if (!replyText) {
      console.error('[AiService] All candidate models failed:', lastError?.message);
      return {
        text: '⚠️ I\'m having trouble connecting to the AI service right now. Please try again in a moment, or browse our menu directly.',
        error: lastError?.message || 'API_ERROR'
      };
    }

    // 7. Update Session History
    session.history.push({ role: 'user', text: userMessage });
    session.history.push({ role: 'model', text: replyText });
    if (session.history.length > this.MAX_HISTORY_TURNS * 2) {
      session.history = session.history.slice(-this.MAX_HISTORY_TURNS * 2);
    }

    return { text: replyText };
  }
}

export const aiService = new AiService();
