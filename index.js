import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { GoogleGenAI } from '@google/genai';
import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  limit as firestoreLimit
} from 'firebase/firestore';

dotenv.config();

// ==========================================
// 1. GLOBAL PROCESS CRASH PROOFING
// ==========================================
process.on('uncaughtException', (err) => {
  const timestamp = new Date().toISOString();
  console.error(`💥 [${timestamp}] [CRASH-PROOF] Uncaught Exception:`, {
    name: err?.name || 'Error',
    message: err?.message || String(err),
    stack: err?.stack || ''
  });
});

process.on('unhandledRejection', (reason) => {
  const timestamp = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  console.error(`⚠️ [${timestamp}] [CRASH-PROOF] Unhandled Rejection:`, { reason: msg, stack });
});

// ==========================================
// 2. CONFIGURATION RESOLUTION
// ==========================================
function resolveConfiguration() {
  let rawToken = process.env.TELEGRAM_BOT_TOKEN ? String(process.env.TELEGRAM_BOT_TOKEN).trim().replace(/^["']|["']$/g, '') : '';
  let rawAdminId = process.env.INITIAL_SUPER_ADMIN_ID ? String(process.env.INITIAL_SUPER_ADMIN_ID).trim().replace(/^["']|["']$/g, '') : '';

  // Auto-detect if secrets were swapped in environment
  const isTokenFormat = (str) => /^\d{6,14}:[A-Za-z0-9_-]{25,}$/.test(str);
  const isNumericUserId = (str) => /^\d{5,14}$/.test(str);

  if (isTokenFormat(rawAdminId) && (isNumericUserId(rawToken) || !rawToken)) {
    console.log('🔄 [Config] Auto-swapping TELEGRAM_BOT_TOKEN and INITIAL_SUPER_ADMIN_ID to correct variables.');
    const temp = rawToken;
    rawToken = rawAdminId;
    rawAdminId = temp;
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    telegramBotToken: rawToken,
    initialSuperAdminId: rawAdminId,
    geminiApiKey: process.env.GEMINI_API_KEY || ''
  };
}

const config = resolveConfiguration();

// ==========================================
// 3. PERSISTENT DATABASE ENGINE (Firestore + File Fallback)
// ==========================================
class DatabaseEngine {
  constructor() {
    this.type = 'file';
    this.firestoreDb = null;
    this.isInitialized = false;
    this.filePath = path.resolve(process.cwd(), 'data', 'db.json');
    this.cache = {
      products: null,
      services: null,
      earning_opportunities: null,
      coupons: null,
      settings: null,
      force_channels: null,
      admins: null
    };
    this.cacheTtlMs = 45000;
    this.data = {
      users: [],
      admins: [],
      products: [],
      services: [],
      earning_opportunities: [],
      coupons: [],
      orders: [],
      payments: [],
      support_tickets: [],
      settings: {},
      referrals: [],
      withdrawals: [],
      force_channels: []
    };
  }

  async init() {
    if (this.isInitialized) return;

    // Check Firebase configuration safely with try/catch
    let rawFirebaseConfig = null;
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    try {
      if (fs.existsSync(configPath)) {
        rawFirebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } else if (process.env.FIREBASE_CONFIG) {
        rawFirebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
      }
    } catch (e) {
      console.warn('⚠️ [DB] Could not parse Firebase config:', e.message);
    }

    if (rawFirebaseConfig) {
      try {
        console.log('🔥 [DB] Initializing Cloud Firestore...');
        const app = initializeApp(rawFirebaseConfig);
        this.firestoreDb = initializeFirestore(app, {}, rawFirebaseConfig.firestoreDatabaseId || '(default)');

        // Ping Firestore
        const pingRef = doc(this.firestoreDb, '_system_health', 'ping');
        await setDoc(pingRef, { timestamp: Date.now(), mode: 'long_polling' }, { merge: true });
        this.type = 'firestore';
        console.log('✅ [DB] Google Cloud Firestore connected successfully.');
      } catch (err) {
        console.warn('⚠️ [DB] Firestore connection failed, using local file store fallback:', err.message);
        this.initFileStore();
      }
    } else {
      console.log('📁 [DB] Initializing persistent local file store (./data/db.json).');
      this.initFileStore();
    }

    try {
      await this.seedDefaults();
    } catch (seedErr) {
      console.warn('⚠️ [DB] Seed defaults warning:', seedErr.message);
    }

    this.isInitialized = true;
  }

  initFileStore() {
    this.type = 'file';
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = { ...this.data, ...JSON.parse(raw) };
      } else {
        this.saveFileStore();
      }
    } catch (err) {
      console.error('Error reading db.json:', err.message);
      this.saveFileStore();
    }
  }

  saveFileStore() {
    try {
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('Failed to save db.json:', err.message);
    }
  }

  getCached(key) {
    const entry = this.cache[key];
    if (entry && (Date.now() - entry.timestamp < this.cacheTtlMs)) {
      return entry.data;
    }
    return null;
  }

  setCached(key, data) {
    this.cache[key] = { data, timestamp: Date.now() };
  }

  invalidateCache(key) {
    this.cache[key] = null;
  }

  async seedDefaults() {
    if (config.initialSuperAdminId) {
      await this.ensureSuperAdmin(config.initialSuperAdminId);
    }

    const defaultSettings = {
      upi_id: 'business@upi',
      receiver_name: 'VYRON Business Automation',
      payment_instructions: '1. Scan QR code or copy UPI ID\n2. Complete payment\n3. Note 12-digit UTR/Txn ID\n4. Upload payment screenshot below',
      qr_image_file_id: '',
      currency: 'INR',
      about_text: '🌟 Welcome to VYRON Business Bot! Your premier automated gateway for enterprise digital assets, premium business services, high-converting affiliate earning programs, and 24/7 dedicated assistance.'
    };

    const currentSettings = await this.getSettings();
    if (!currentSettings || Object.keys(currentSettings).length === 0) {
      await this.saveSettings(defaultSettings);
    }

    const products = await this.getProducts();
    if (products.length === 0) {
      await this.saveProduct({
        id: 'prod_' + Date.now(),
        name: 'VIP Business Automation E-Book & Toolkit',
        description: 'Comprehensive business growth blueprint, workflows, templates, and digital assets.',
        price: 499,
        type: 'digital',
        stock: 0,
        is_unlimited: true,
        delivery_info: 'Instant access download link delivered immediately upon payment verification.',
        image_url: '',
        is_active: true
      });
    }

    const services = await this.getServices();
    if (services.length === 0) {
      await this.saveService({
        id: 'srv_' + Date.now(),
        name: 'Custom 24/7 Telegram Bot Setup & Cloud Deployment',
        description: 'Complete end-to-end bot development, payment gateway integration, and free cloud hosting setup.',
        price: 2499,
        delivery_time: '24-48 Hours',
        requirements: 'Provide your business name, desired features, and BotFather token.',
        image_url: '',
        is_active: true
      });
    }

    const opps = await this.getEarningOpportunities();
    if (opps.length === 0) {
      await this.saveEarningOpportunity({
        id: 'earn_' + Date.now(),
        name: 'Affiliate Partner Program',
        description: 'Earn ₹2 per friend referral + 20% lifetime commission on every purchase.',
        reward_info: '₹2 Join Bonus + 20% Order Commission',
        how_to_earn: '1. Share your personal referral link.\n2. When new users join, you earn ₹2 instantly.\n3. When they buy, earn 20% commission.\n4. Withdraw balance anytime via UPI.',
        external_url: 'https://telegram.org',
        referral_info: 'Track real-time earnings directly in the "💰 Earn Money" tab.',
        terms: 'Fair usage only. Self-referrals will result in account suspension.',
        image_url: '',
        is_active: true
      });
    }

    const coupons = await this.getCoupons();
    if (coupons.length === 0) {
      await this.saveCoupon({
        code: 'WELCOME20',
        description: '20% Welcome Discount for new members',
        discount_type: 'percent',
        discount_value: 20,
        expiry_date: null,
        usage_limit: 5000,
        times_used: 0,
        applicable_to: 'all',
        is_active: true
      });
    }
  }

  // --- Admin Methods ---
  async ensureSuperAdmin(telegramId) {
    const tid = String(telegramId);
    const existing = await this.getAdmin(tid);
    if (!existing) {
      await this.saveAdmin({
        telegram_id: tid,
        username: 'SuperAdmin',
        role: 'super_admin',
        permissions: ['*'],
        added_at: new Date().toISOString(),
        added_by: 'system'
      });
      console.log(`👑 [Admin] Super Admin configured: ${tid}`);
    } else if (existing.role !== 'super_admin') {
      existing.role = 'super_admin';
      existing.permissions = ['*'];
      await this.saveAdmin(existing);
    }
  }

  async getAdmin(telegramId) {
    const tid = String(telegramId);
    const cached = this.getCached('admins');
    if (cached) {
      const found = cached.find(a => String(a.telegram_id) === tid);
      if (found) return found;
    }
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'admins', tid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.admins?.find(a => String(a.telegram_id) === tid) || null;
  }

  async getAdmins() {
    const cached = this.getCached('admins');
    if (cached) return cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'admins'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        this.setCached('admins', list);
        return list;
      } catch {
        return [];
      }
    }
    return this.data.admins || [];
  }

  async saveAdmin(admin) {
    const tid = String(admin.telegram_id);
    const payload = { ...admin, telegram_id: tid, updated_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'admins', tid), payload, { merge: true });
      } catch (e) {
        console.error('Error saving admin to firestore:', e.message);
      }
    } else {
      const idx = this.data.admins.findIndex(a => String(a.telegram_id) === tid);
      if (idx >= 0) this.data.admins[idx] = { ...this.data.admins[idx], ...payload };
      else this.data.admins.push(payload);
      this.saveFileStore();
    }
    this.invalidateCache('admins');
    return payload;
  }

  async deleteAdmin(telegramId) {
    const tid = String(telegramId);
    if (this.type === 'firestore') {
      try {
        await deleteDoc(doc(this.firestoreDb, 'admins', tid));
      } catch {}
    } else {
      this.data.admins = this.data.admins.filter(a => String(a.telegram_id) !== tid);
      this.saveFileStore();
    }
    this.invalidateCache('admins');
  }

  // --- Users Methods ---
  async upsertUser(user) {
    const tid = String(user.telegram_id);
    const existing = await this.getUser(tid);
    const payload = {
      telegram_id: tid,
      username: user.username !== undefined ? user.username : (existing?.username || ''),
      first_name: user.first_name || existing?.first_name || 'User',
      is_blocked: user.is_blocked !== undefined ? user.is_blocked : (existing?.is_blocked || false),
      withdrawable_balance: user.withdrawable_balance !== undefined ? Number(user.withdrawable_balance) : Number(existing?.withdrawable_balance || 0),
      referral_count: user.referral_count !== undefined ? Number(user.referral_count) : Number(existing?.referral_count || 0),
      joined_at: existing?.joined_at || new Date().toISOString(),
      last_active_at: new Date().toISOString()
    };
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'users', tid), payload, { merge: true });
      } catch {}
    } else {
      const idx = this.data.users.findIndex(u => String(u.telegram_id) === tid);
      if (idx >= 0) this.data.users[idx] = { ...this.data.users[idx], ...payload };
      else this.data.users.push(payload);
      this.saveFileStore();
    }
    return payload;
  }

  async getUser(telegramId) {
    const tid = String(telegramId);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'users', tid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.users?.find(u => String(u.telegram_id) === tid) || null;
  }

  async getUsers() {
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'users'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        return list;
      } catch {
        return [];
      }
    }
    return this.data.users || [];
  }

  async setUserBlocked(telegramId, isBlocked) {
    const tid = String(telegramId);
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'users', tid), { is_blocked: Boolean(isBlocked) }, { merge: true });
      } catch {}
    } else {
      const user = this.data.users?.find(u => String(u.telegram_id) === tid);
      if (user) {
        user.is_blocked = Boolean(isBlocked);
        this.saveFileStore();
      }
    }
  }

  // --- Products Methods ---
  async getProducts(activeOnly = false) {
    const cached = this.getCached('products');
    if (cached) return activeOnly ? cached.filter(p => p.is_active) : cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'products'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        this.setCached('products', list);
        return activeOnly ? list.filter(p => p.is_active) : list;
      } catch {
        return [];
      }
    }
    const list = this.data.products || [];
    return activeOnly ? list.filter(p => p.is_active) : list;
  }

  async getProduct(id) {
    const pid = String(id);
    const cached = this.getCached('products');
    if (cached) {
      const found = cached.find(p => String(p.id) === pid);
      if (found) return found;
    }
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'products', pid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.products?.find(p => String(p.id) === pid) || null;
  }

  async saveProduct(product) {
    if (!product.id) product.id = 'prod_' + Date.now();
    product.is_active = product.is_active ?? true;
    product.stock = product.stock !== undefined ? Number(product.stock) : 0;
    product.price = Number(product.price);
    product.created_at = product.created_at || new Date().toISOString();

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'products', String(product.id)), product, { merge: true });
      } catch {}
    } else {
      const idx = this.data.products.findIndex(p => String(p.id) === String(product.id));
      if (idx >= 0) this.data.products[idx] = { ...this.data.products[idx], ...product };
      else this.data.products.push(product);
      this.saveFileStore();
    }
    this.invalidateCache('products');
    return product;
  }

  async deleteProduct(id) {
    const pid = String(id);
    if (this.type === 'firestore') {
      try {
        await deleteDoc(doc(this.firestoreDb, 'products', pid));
      } catch {}
    } else {
      this.data.products = this.data.products.filter(p => String(p.id) !== pid);
      this.saveFileStore();
    }
    this.invalidateCache('products');
  }

  // --- Services Methods ---
  async getServices(activeOnly = false) {
    const cached = this.getCached('services');
    if (cached) return activeOnly ? cached.filter(s => s.is_active) : cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'services'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        this.setCached('services', list);
        return activeOnly ? list.filter(s => s.is_active) : list;
      } catch {
        return [];
      }
    }
    const list = this.data.services || [];
    return activeOnly ? list.filter(s => s.is_active) : list;
  }

  async getService(id) {
    const sid = String(id);
    const cached = this.getCached('services');
    if (cached) {
      const found = cached.find(s => String(s.id) === sid);
      if (found) return found;
    }
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'services', sid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.services?.find(s => String(s.id) === sid) || null;
  }

  async saveService(service) {
    if (!service.id) service.id = 'srv_' + Date.now();
    service.is_active = service.is_active ?? true;
    service.price = Number(service.price);
    service.created_at = service.created_at || new Date().toISOString();

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'services', String(service.id)), service, { merge: true });
      } catch {}
    } else {
      const idx = this.data.services.findIndex(s => String(s.id) === String(service.id));
      if (idx >= 0) this.data.services[idx] = { ...this.data.services[idx], ...service };
      else this.data.services.push(service);
      this.saveFileStore();
    }
    this.invalidateCache('services');
    return service;
  }

  async deleteService(id) {
    const sid = String(id);
    if (this.type === 'firestore') {
      try {
        await deleteDoc(doc(this.firestoreDb, 'services', sid));
      } catch {}
    } else {
      this.data.services = this.data.services.filter(s => String(s.id) !== sid);
      this.saveFileStore();
    }
    this.invalidateCache('services');
  }

  // --- Earning Opportunities Methods ---
  async getEarningOpportunities(activeOnly = false) {
    const cached = this.getCached('earning_opportunities');
    if (cached) return activeOnly ? cached.filter(o => o.is_active) : cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'earning_opportunities'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        this.setCached('earning_opportunities', list);
        return activeOnly ? list.filter(o => o.is_active) : list;
      } catch {
        return [];
      }
    }
    const list = this.data.earning_opportunities || [];
    return activeOnly ? list.filter(o => o.is_active) : list;
  }

  async saveEarningOpportunity(opportunity) {
    if (!opportunity.id) opportunity.id = 'earn_' + Date.now();
    opportunity.is_active = opportunity.is_active ?? true;
    opportunity.created_at = opportunity.created_at || new Date().toISOString();

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'earning_opportunities', String(opportunity.id)), opportunity, { merge: true });
      } catch {}
    } else {
      const idx = this.data.earning_opportunities.findIndex(o => String(o.id) === String(opportunity.id));
      if (idx >= 0) this.data.earning_opportunities[idx] = { ...this.data.earning_opportunities[idx], ...opportunity };
      else this.data.earning_opportunities.push(opportunity);
      this.saveFileStore();
    }
    this.invalidateCache('earning_opportunities');
    return opportunity;
  }

  // --- Coupons Methods ---
  async getCoupons(activeOnly = false) {
    const cached = this.getCached('coupons');
    if (cached) return activeOnly ? cached.filter(c => c.is_active) : cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'coupons'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        this.setCached('coupons', list);
        return activeOnly ? list.filter(c => c.is_active) : list;
      } catch {
        return [];
      }
    }
    const list = this.data.coupons || [];
    return activeOnly ? list.filter(c => c.is_active) : list;
  }

  async saveCoupon(coupon) {
    const cCode = String(coupon.code).toUpperCase().trim();
    const payload = {
      ...coupon,
      code: cCode,
      is_active: coupon.is_active ?? true,
      discount_value: Number(coupon.discount_value),
      created_at: coupon.created_at || new Date().toISOString()
    };
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'coupons', cCode), payload, { merge: true });
      } catch {}
    } else {
      const idx = this.data.coupons.findIndex(c => String(c.code).toUpperCase() === cCode);
      if (idx >= 0) this.data.coupons[idx] = { ...this.data.coupons[idx], ...payload };
      else this.data.coupons.push(payload);
      this.saveFileStore();
    }
    this.invalidateCache('coupons');
    return payload;
  }

  // --- Orders Methods ---
  async createOrder(order) {
    if (!order.id) order.id = 'ord_' + Date.now();
    if (!order.order_number) order.order_number = 'VY-' + Math.floor(10000000 + Math.random() * 90000000);
    order.status = order.status || 'pending';
    order.created_at = order.created_at || new Date().toISOString();
    order.updated_at = new Date().toISOString();
    order.final_amount = Number(order.final_amount);
    order.original_amount = Number(order.original_amount);
    order.discount = Number(order.discount || 0);

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'orders', String(order.id)), order, { merge: true });
      } catch {}
    } else {
      const idx = this.data.orders.findIndex(o => String(o.id) === String(order.id));
      if (idx >= 0) this.data.orders[idx] = order;
      else this.data.orders.push(order);
      this.saveFileStore();
    }
    return order;
  }

  async getOrder(id) {
    const oid = String(id);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'orders', oid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.orders?.find(o => String(o.id) === oid) || null;
  }

  async getUserOrders(telegramId) {
    const tid = String(telegramId);
    if (this.type === 'firestore') {
      try {
        const q = query(collection(this.firestoreDb, 'orders'), where('user_telegram_id', '==', tid));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    return (this.data.orders || [])
      .filter(o => String(o.user_telegram_id) === tid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async updateOrderStatus(id, status, deliveryInfo = '') {
    const oid = String(id);
    const order = await this.getOrder(oid);
    if (!order) return null;

    const updates = { status, updated_at: new Date().toISOString() };
    if (deliveryInfo) updates.delivery_info = deliveryInfo;

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'orders', oid), updates, { merge: true });
      } catch {}
    } else {
      const idx = this.data.orders.findIndex(o => String(o.id) === oid);
      if (idx >= 0) this.data.orders[idx] = { ...this.data.orders[idx], ...updates };
      this.saveFileStore();
    }
    return { ...order, ...updates };
  }

  async updateOrderPaymentProof(id, proofFileId, utrNumber = '') {
    const oid = String(id);
    const updates = {
      payment_proof_file_id: proofFileId,
      utr_number: utrNumber,
      updated_at: new Date().toISOString()
    };
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'orders', oid), updates, { merge: true });
      } catch {}
    } else {
      const idx = this.data.orders.findIndex(o => String(o.id) === oid);
      if (idx >= 0) this.data.orders[idx] = { ...this.data.orders[idx], ...updates };
      this.saveFileStore();
    }
    return await this.getOrder(oid);
  }

  // --- Payments Methods ---
  async createPayment(payment) {
    if (!payment.id) payment.id = 'pay_' + Date.now();
    payment.status = payment.status || 'pending';
    payment.created_at = payment.created_at || new Date().toISOString();
    payment.amount = Number(payment.amount);

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'payments', String(payment.id)), payment, { merge: true });
      } catch {}
    } else {
      this.data.payments.push(payment);
      this.saveFileStore();
    }
    return payment;
  }

  // --- Support Tickets Methods ---
  async createSupportTicket(ticket) {
    if (!ticket.id) ticket.id = 'tkt_' + Date.now();
    if (!ticket.ticket_number) ticket.ticket_number = 'TKT-' + Math.floor(10000 + Math.random() * 90000);
    ticket.status = ticket.status || 'open';
    ticket.messages = ticket.messages || [];
    ticket.created_at = ticket.created_at || new Date().toISOString();
    ticket.updated_at = new Date().toISOString();

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'support_tickets', String(ticket.id)), ticket);
      } catch {}
    } else {
      this.data.support_tickets.push(ticket);
      this.saveFileStore();
    }
    return ticket;
  }

  async getUserSupportTickets(telegramId) {
    const tid = String(telegramId);
    if (this.type === 'firestore') {
      try {
        const q = query(collection(this.firestoreDb, 'support_tickets'), where('user_telegram_id', '==', tid));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    return (this.data.support_tickets || []).filter(t => String(t.user_telegram_id) === tid);
  }

  // --- Settings Methods ---
  async getSettings() {
    const cached = this.getCached('settings');
    if (cached) return cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'settings', 'global_config'));
        if (snap.exists()) {
          const data = snap.data();
          this.setCached('settings', data);
          return data;
        }
        return {};
      } catch {
        return {};
      }
    }
    return this.data.settings || {};
  }

  async saveSettings(settings) {
    const payload = { ...settings, updated_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'settings', 'global_config'), payload, { merge: true });
      } catch {}
    } else {
      this.data.settings = { ...this.data.settings, ...payload };
      this.saveFileStore();
    }
    this.setCached('settings', payload);
    return payload;
  }

  // --- Force Channels Methods ---
  async getForceChannels(activeOnly = false) {
    const cached = this.getCached('force_channels');
    if (cached) return activeOnly ? cached.filter(c => c.is_active) : cached;
    if (this.type === 'firestore') {
      try {
        const snap = await getDocs(collection(this.firestoreDb, 'force_channels'));
        const list = [];
        snap.forEach(d => list.push(d.data()));
        this.setCached('force_channels', list);
        return activeOnly ? list.filter(c => c.is_active) : list;
      } catch {
        return [];
      }
    }
    const list = this.data.force_channels || [];
    return activeOnly ? list.filter(c => c.is_active) : list;
  }

  // --- Referrals & Affiliate Methods ---
  async recordReferralJoin(newUserId, referrerId, newUserName) {
    const refId = String(referrerId);
    const newUid = String(newUserId);
    if (refId === newUid) return null;

    const referrer = await this.getUser(refId);
    if (!referrer) return null;

    const reward = 2.0;
    const newBalance = Number(referrer.withdrawable_balance || 0) + reward;
    const newCount = Number(referrer.referral_count || 0) + 1;

    await this.upsertUser({
      telegram_id: refId,
      withdrawable_balance: newBalance,
      referral_count: newCount
    });

    const referralDoc = {
      id: 'ref_join_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      referrer_id: refId,
      referred_id: newUid,
      referred_name: newUserName || '',
      type: 'join',
      amount: reward,
      created_at: new Date().toISOString()
    };

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'referrals', referralDoc.id), referralDoc);
      } catch {}
    } else {
      if (!this.data.referrals) this.data.referrals = [];
      this.data.referrals.push(referralDoc);
      this.saveFileStore();
    }

    return { success: true, reward, newBalance, referrerId: refId };
  }

  async getReferrals(referrerId) {
    const refId = String(referrerId);
    if (this.type === 'firestore') {
      try {
        const q = query(collection(this.firestoreDb, 'referrals'), where('referrer_id', '==', refId));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    return (this.data.referrals || []).filter(r => String(r.referrer_id) === refId);
  }

  // --- Withdrawals Methods ---
  async createWithdrawal(telegramId, userName, amount, paymentDetails) {
    const tid = String(telegramId);
    const user = await this.getUser(tid);
    const amt = Number(amount);
    if (!user || Number(user.withdrawable_balance || 0) < amt) {
      throw new Error('Insufficient withdrawable balance.');
    }

    const updatedWithdrawable = Number(user.withdrawable_balance || 0) - amt;
    await this.upsertUser({ telegram_id: tid, withdrawable_balance: updatedWithdrawable });

    const withdrawal = {
      id: 'wth_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      user_telegram_id: tid,
      user_name: userName || user.first_name || '',
      amount: amt,
      payment_details: paymentDetails,
      status: 'pending',
      admin_reason: '',
      created_at: new Date().toISOString(),
      reviewed_at: null
    };

    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'withdrawals', withdrawal.id), withdrawal);
      } catch {}
    } else {
      if (!this.data.withdrawals) this.data.withdrawals = [];
      this.data.withdrawals.push(withdrawal);
      this.saveFileStore();
    }
    return withdrawal;
  }

  async getDashboardStats() {
    try {
      const [users, orders, products, services] = await Promise.all([
        this.getUsers(),
        this.getUserOrders(''),
        this.getProducts(),
        this.getServices()
      ]);

      return {
        totalUsers: users.length,
        totalOrders: orders.length,
        totalProducts: products.length,
        totalServices: services.length
      };
    } catch {
      return { totalUsers: 0, totalOrders: 0, totalProducts: 0, totalServices: 0 };
    }
  }
}

export const db = new DatabaseEngine();

// ==========================================
// 4. TELEGRAM KEYBOARDS & UI HELPERS
// ==========================================
export const keyboards = {
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
      keyboard.push([{ text: '⚙️ Admin Panel', style: 'danger' }]);
    }
    keyboard.push([{ text: '❌ Close Menu', style: 'danger' }]);
    return { keyboard, resize_keyboard: true };
  },

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

  supportReplyMenu() {
    return {
      keyboard: [
        [
          { text: '➕ Create Ticket', style: 'success' },
          { text: '📋 My Tickets', style: 'primary' }
        ],
        [{ text: '🔙 Back', style: 'primary' }]
      ],
      resize_keyboard: true
    };
  },

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
        [{ text: '🔙 Back', style: 'primary' }]
      ],
      resize_keyboard: true
    };
  },

  aiReplyMenu() {
    return {
      keyboard: [[{ text: '🔙 Exit AI Assistant', style: 'danger' }]],
      resize_keyboard: true
    };
  },

  adminReplyMenu() {
    return {
      keyboard: [
        [
          { text: '📊 Dashboard', style: 'primary' },
          { text: '🗂️ Products', style: 'primary' }
        ],
        [
          { text: '🔙 Back to User Menu', style: 'danger' }
        ]
      ],
      resize_keyboard: true
    };
  },

  productListInline(products) {
    const inline_keyboard = [];
    products.forEach(p => {
      const stockBadge = !p.is_unlimited && p.stock <= 0 ? ' [Out of Stock]' : '';
      inline_keyboard.push([{ text: `🛍️ ${p.name} - ₹${p.price}${stockBadge}`, callback_data: `user:product:${p.id}` }]);
    });
    return { inline_keyboard };
  },

  productDetailInline(product) {
    const isOutOfStock = !product.is_unlimited && product.stock <= 0;
    const inline_keyboard = [];
    if (isOutOfStock) {
      inline_keyboard.push([{ text: '⚠️ Currently Out of Stock', callback_data: 'noop' }]);
    } else {
      inline_keyboard.push([{ text: `🛒 Buy Now (₹${product.price})`, callback_data: `order:start:product:${product.id}` }]);
    }
    inline_keyboard.push([{ text: '🔙 Back to Products', callback_data: 'user:products:list' }]);
    return { inline_keyboard };
  },

  serviceListInline(services) {
    const inline_keyboard = [];
    services.forEach(s => {
      inline_keyboard.push([{ text: `🧑💻 ${s.name} - ₹${s.price}`, callback_data: `user:service:${s.id}` }]);
    });
    return { inline_keyboard };
  },

  serviceDetailInline(service) {
    return {
      inline_keyboard: [
        [{ text: `📩 Order Service (₹${service.price})`, callback_data: `order:start:service:${service.id}` }],
        [{ text: '🔙 Back to Services', callback_data: 'user:services:list' }]
      ]
    };
  },

  orderActions(order) {
    const inline_keyboard = [];
    if (order.status === 'pending') {
      inline_keyboard.push([{ text: '💳 Submit Payment Proof 📸', callback_data: `order:pay:${order.id}` }]);
      inline_keyboard.push([{ text: '❌ Cancel Order', callback_data: `order:cancel:${order.id}` }]);
    }
    return { inline_keyboard };
  },

  forceChannelJoinInline(channels) {
    const inline_keyboard = [];
    channels.forEach(ch => {
      inline_keyboard.push([{ text: `📢 Join ${ch.channel_name}`, url: ch.invite_link }]);
    });
    inline_keyboard.push([{ text: '🔄 I Have Joined', callback_data: 'user:check_joined' }]);
    return { inline_keyboard };
  }
};

// ==========================================
// 5. IN-MEMORY CONVERSATION & STATE MANAGER
// ==========================================
class StateManager {
  constructor() {
    this.states = new Map();
  }
  get(userId) {
    return this.states.get(String(userId)) || null;
  }
  set(userId, data) {
    this.states.set(String(userId), { ...data, timestamp: Date.now() });
  }
  clear(userId) {
    this.states.delete(String(userId));
  }
}
const stateManager = new StateManager();

// ==========================================
// 6. GEMINI AI ASSISTANT SERVICE
// ==========================================
class AiService {
  constructor() {
    this.activeSessions = new Set();
    this.aiInstance = null;
    if (config.geminiApiKey) {
      try {
        this.aiInstance = new GoogleGenAI({ apiKey: config.geminiApiKey });
      } catch (e) {
        console.warn('⚠️ Gemini AI client initialization warning:', e.message);
      }
    }
  }

  isAiActive(userId) {
    return this.activeSessions.has(String(userId));
  }

  startAiSession(userId) {
    this.activeSessions.add(String(userId));
  }

  exitAiSession(userId) {
    this.activeSessions.delete(String(userId));
  }

  async generateAiResponse(userId, prompt) {
    const [products, services, opps, settings] = await Promise.all([
      db.getProducts(true),
      db.getServices(true),
      db.getEarningOpportunities(true),
      db.getSettings()
    ]);

    if (!this.aiInstance) {
      // Smart offline fallback
      const lower = prompt.toLowerCase();
      if (lower.includes('product') || lower.includes('buy') || lower.includes('toolkit')) {
        return { text: `🛍️ *VYRON Products:*\n\n` + products.map(p => `• *${p.name}* — ₹${p.price}\n  _${p.description}_`).join('\n\n') + `\n\nTap *🛍️ Products* in the menu to purchase!` };
      }
      if (lower.includes('service') || lower.includes('bot') || lower.includes('setup')) {
        return { text: `🧑💻 *Business Services:*\n\n` + services.map(s => `• *${s.name}* — ₹${s.price}\n  _${s.description}_`).join('\n\n') + `\n\nTap *🧑💻 Services* to order!` };
      }
      if (lower.includes('earn') || lower.includes('refer') || lower.includes('money')) {
        return { text: `💰 *Affiliate Program:*\n\n• Get *₹2 instant bonus* per friend referral.\n• Earn *20% commission* on all purchases.\n\nTap *💰 Earn Money* to get your link!` };
      }
      return { text: `🤖 *VYRON AI Assistant:*\n\nI can help you explore products, custom Telegram bot engineering, and affiliate income programs.\n\nHow can I help you today?` };
    }

    try {
      const catalogKnowledge = `
VYRON BUSINESS INFO:
About: ${settings.about_text || 'Premium business services, digital products, and earning programs.'}
UPI ID: ${settings.upi_id || 'business@upi'} (${settings.receiver_name || 'VYRON Business'})

Available Products:
${products.map(p => `- ${p.name} (₹${p.price}): ${p.description}`).join('\n') || 'None'}

Available Services:
${services.map(s => `- ${s.name} (₹${s.price}) [Turnaround: ${s.delivery_time || '24-48h'}]: ${s.description}`).join('\n') || 'None'}
`;

      const response = await this.aiInstance.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction: `You are VYRON AI, the friendly customer assistant for VYRON Business. Keep responses concise, formatted with Telegram Markdown.\n${catalogKnowledge}`,
          temperature: 0.7,
          maxOutputTokens: 400
        }
      });

      return { text: response.text || 'How else can I assist you with VYRON services today?' };
    } catch (err) {
      console.warn('⚠️ Gemini generation fallback:', err.message);
      return { text: `🤖 *VYRON AI Assistant:*\n\nWe offer digital toolkits, custom Telegram bot engineering, and affiliate earnings.\n\nHow can I assist you today?` };
    }
  }
}
const aiService = new AiService();

// ==========================================
// 7. GRAMMY TELEGRAM BOT SETUP (POLLING MODE)
// ==========================================
export function createTelegramBot() {
  if (!config.telegramBotToken) {
    console.warn('⚠️ [Bot] TELEGRAM_BOT_TOKEN is not configured yet.');
    return null;
  }

  const bot = new Bot(config.telegramBotToken);

  // Global error handler in grammY
  bot.catch((err) => {
    console.error('Bot error caught:', {
      update_id: err.ctx?.update?.update_id,
      error: err.error?.message || err.message
    });
  });

  // Force channels validator
  const checkForceChannels = async (ctx) => {
    try {
      const channels = await db.getForceChannels(true);
      if (!channels || channels.length === 0) return true;
      const notJoined = [];
      for (const ch of channels) {
        try {
          const member = await bot.api.getChatMember(ch.channel_id, ctx.from.id);
          if (['left', 'kicked'].includes(member.status)) notJoined.push(ch);
        } catch {}
      }
      if (notJoined.length > 0) {
        await ctx.reply(
          '📢 *Mandatory Channel Subscription*\n\nPlease join our official channel(s) below to access VYRON Business Bot:',
          { parse_mode: 'Markdown', reply_markup: keyboards.forceChannelJoinInline(notJoined) }
        );
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  // Commands
  bot.command('start', async (ctx) => {
    try {
      const from = ctx.from;
      if (!from) return;

      const hasJoined = await checkForceChannels(ctx);
      if (!hasJoined) return;

      let referrerId = null;
      const match = (ctx.match || '').trim();
      if (match.startsWith('ref_')) referrerId = match.replace('ref_', '');
      else if (/^\d+$/.test(match)) referrerId = match;

      const existingUser = await db.getUser(from.id);
      const isNewUser = !existingUser;

      await db.upsertUser({
        telegram_id: from.id,
        username: from.username || '',
        first_name: from.first_name || 'User'
      });

      if (isNewUser && referrerId && String(referrerId) !== String(from.id)) {
        const rewardResult = await db.recordReferralJoin(from.id, referrerId, from.first_name);
        if (rewardResult) {
          try {
            await bot.api.sendMessage(
              rewardResult.referrerId,
              `🎉 *New Referral Joined!*\n\n*${from.first_name}* joined using your link. You earned *₹${rewardResult.reward.toFixed(2)}*! 💰`,
              { parse_mode: 'Markdown' }
            );
          } catch {}
        }
      }

      stateManager.clear(from.id);
      aiService.exitAiSession(from.id);
      const admin = await db.getAdmin(from.id);

      const welcomeText =
        `👋 *Welcome to VYRON Business Bot, ${from.first_name || 'Friend'}!*\n\n` +
        `🚀 Your all-in-one platform for premium digital products, custom bot development, business services, and affiliate earnings.\n\n` +
        `👇 *Choose an option below to get started:*`;

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fullMenu(Boolean(admin))
      });
    } catch (err) {
      console.error('Error in /start:', err.message);
    }
  });

  bot.command('menu', async (ctx) => {
    try {
      const admin = await db.getAdmin(ctx.from.id);
      await ctx.reply('📱 *VYRON Navigation Menu:*', {
        parse_mode: 'Markdown',
        reply_markup: keyboards.fullMenu(Boolean(admin))
      });
    } catch (e) {
      console.error('Error in /menu:', e.message);
    }
  });

  bot.command('orders', async (ctx) => {
    try {
      const orders = await db.getUserOrders(ctx.from.id);
      if (orders.length === 0) {
        return ctx.reply('📦 You have no active orders yet. Browse *🛍️ Products* or *🧑💻 Services* to place an order!', {
          parse_mode: 'Markdown'
        });
      }
      let msg = `📦 *Your Recent Orders (${orders.length}):*\n\n`;
      orders.slice(0, 5).forEach((o, i) => {
        const statusEmoji = o.status === 'completed' ? '✅' : '⏳';
        msg += `${i + 1}. *${o.item_name}*\n   🆔 \`${o.order_number}\` | 💵 ₹${o.final_amount} | ${statusEmoji} *${o.status.toUpperCase()}*\n\n`;
      });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Error in /orders:', e.message);
    }
  });

  bot.command('ai', async (ctx) => {
    try {
      stateManager.clear(ctx.from.id);
      aiService.startAiSession(ctx.from.id);
      await ctx.reply(
        '🤖 *VYRON Business AI Assistant Active*\n\nAsk me anything about our products, bot setups, pricing, or earning money!',
        { parse_mode: 'Markdown', reply_markup: keyboards.aiReplyMenu() }
      );
    } catch (e) {
      console.error('Error in /ai:', e.message);
    }
  });

  bot.command('account', async (ctx) => {
    try {
      const user = await db.getUser(ctx.from.id);
      const orders = await db.getUserOrders(ctx.from.id);
      const referrals = await db.getReferrals(ctx.from.id);

      const msg =
        `👤 *My VYRON Profile*\n\n` +
        `🆔 *User ID:* \`${ctx.from.id}\`\n` +
        `👤 *Name:* ${ctx.from.first_name || 'Member'}\n` +
        `💰 *Wallet Balance:* ₹${Number(user?.withdrawable_balance || 0).toFixed(2)}\n` +
        `👥 *Referrals:* ${referrals.length}\n` +
        `📦 *Total Orders:* ${orders.length}`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Error in /account:', e.message);
    }
  });

  bot.command('support', async (ctx) => {
    try {
      await ctx.reply(
        '🎫 *VYRON Customer Support Center*\n\nNeed assistance with an order or inquiry? Create a ticket below:',
        { parse_mode: 'Markdown', reply_markup: keyboards.supportReplyMenu() }
      );
    } catch (e) {
      console.error('Error in /support:', e.message);
    }
  });

  bot.command('admin', async (ctx) => {
    try {
      const admin = await db.getAdmin(ctx.from.id);
      if (!admin) {
        return ctx.reply('⛔ *Access Denied:* You do not have administrator permissions.', { parse_mode: 'Markdown' });
      }
      const stats = await db.getDashboardStats();
      const msg =
        `⚙️ *VYRON Admin Control Panel*\n\n` +
        `👑 *Role:* ${admin.role?.toUpperCase() || 'ADMIN'}\n` +
        `👥 *Users:* ${stats.totalUsers} | 📦 *Orders:* ${stats.totalOrders}\n` +
        `🛍️ *Products:* ${stats.totalProducts} | 🧑💻 *Services:* ${stats.totalServices}`;

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: keyboards.adminReplyMenu()
      });
    } catch (e) {
      console.error('Error in /admin:', e.message);
    }
  });

  // Message router
  bot.on(['message:text', 'message:photo'], async (ctx) => {
    try {
      const fromId = ctx.from?.id;
      if (!fromId) return;

      const user = await db.getUser(fromId);
      if (user?.is_blocked) {
        return ctx.reply('🚫 Your account has been suspended by administration.');
      }

      const text = ctx.message.text ? ctx.message.text.trim() : '';
      const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : null;

      // Bottom Keyboards
      if (text === '🛍️ Products') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const products = await db.getProducts(true);
        if (products.length === 0) return ctx.reply('🛍️ No products currently in catalog.');
        return ctx.reply('🛍️ *Select a Product:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.productListInline(products)
        });
      }

      if (text === '🧑💻 Services') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const services = await db.getServices(true);
        if (services.length === 0) return ctx.reply('🧑💻 No services currently listed.');
        return ctx.reply('🧑💻 *Select a Service:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.serviceListInline(services)
        });
      }

      if (text === '💰 Earn Money' || text === '💰 Balance') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const me = await db.getUser(fromId);
        const botUser = bot.botInfo?.username || 'VyronBot';
        const refLink = `https://t.me/${botUser}?start=ref_${fromId}`;
        const bal = Number(me?.withdrawable_balance || 0).toFixed(2);
        const count = me?.referral_count || 0;

        const msg =
          `💰 *VYRON Affiliate Partner Center*\n\n` +
          `💵 *Withdrawable Balance:* ₹${bal}\n` +
          `👥 *Total Friends Invited:* ${count}\n` +
          `🎁 *Join Bonus:* ₹2.00 per referral\n` +
          `📈 *Commission:* 20% on all orders\n\n` +
          `🔗 *Your Unique Referral Link:*\n\`${refLink}\``;

        return ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboards.earnReplyMenu() });
      }

      if (text === '🔗 My Referral Link') {
        const botUser = bot.botInfo?.username || 'VyronBot';
        const refLink = `https://t.me/${botUser}?start=ref_${fromId}`;
        return ctx.reply(`🔗 *Share your referral link to earn ₹2 instantly per user:*\n\n\`${refLink}\``, {
          parse_mode: 'Markdown'
        });
      }

      if (text === '💸 Withdraw') {
        const me = await db.getUser(fromId);
        const bal = Number(me?.withdrawable_balance || 0);
        if (bal < 50) {
          return ctx.reply(`⚠️ Minimum withdrawal amount is *₹50.00*. Your balance is *₹${bal.toFixed(2)}*.`, {
            parse_mode: 'Markdown'
          });
        }
        stateManager.set(fromId, { step: 'awaiting_withdrawal_details', balance: bal });
        return ctx.reply(`💸 *Request Payout (Balance: ₹${bal.toFixed(2)})*\n\nPlease reply with your *UPI ID* (e.g. \`name@upi\`):`, {
          parse_mode: 'Markdown'
        });
      }

      if (text === '🎁 Offers') {
        const coupons = await db.getCoupons(true);
        if (coupons.length === 0) return ctx.reply('🎁 No coupons currently active.');
        let msg = `🎁 *Active Discount Coupons:*\n\n`;
        coupons.forEach(c => {
          const discount = c.discount_type === 'percent' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`;
          msg += `🎟️ Code: \`${c.code}\` — *${discount}*\n   _${c.description}_\n\n`;
        });
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === '📦 Orders') {
        const orders = await db.getUserOrders(fromId);
        if (orders.length === 0) return ctx.reply('📦 You have no orders yet.');
        let msg = `📦 *Your Order History:*\n\n`;
        orders.slice(0, 5).forEach((o, i) => {
          msg += `${i + 1}. *${o.item_name}*\n   🆔 \`${o.order_number}\` | 💵 ₹${o.final_amount} | Status: *${o.status.toUpperCase()}*\n\n`;
        });
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === '👤 Account') {
        const me = await db.getUser(fromId);
        const orders = await db.getUserOrders(fromId);
        const msg =
          `👤 *Account Overview*\n\n` +
          `🆔 \`${fromId}\`\n` +
          `👤 *Name:* ${ctx.from.first_name}\n` +
          `💰 *Balance:* ₹${Number(me?.withdrawable_balance || 0).toFixed(2)}\n` +
          `📦 *Orders:* ${orders.length}`;
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === '🎫 Support') {
        return ctx.reply('🎫 *VYRON Support Center:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.supportReplyMenu()
        });
      }

      if (text === '➕ Create Ticket') {
        stateManager.set(fromId, { step: 'awaiting_ticket_subject' });
        return ctx.reply('✍️ Please type a brief description for your support ticket:');
      }

      if (text === '📋 My Tickets') {
        const tickets = await db.getUserSupportTickets(fromId);
        if (tickets.length === 0) return ctx.reply('📋 You have no active support tickets.');
        let msg = `📋 *Your Support Tickets:*\n\n`;
        tickets.slice(0, 5).forEach((t, i) => {
          msg += `${i + 1}. \`${t.ticket_number}\` — *${t.subject}*\n   Status: *${t.status.toUpperCase()}*\n\n`;
        });
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === 'ℹ️ About') {
        const settings = await db.getSettings();
        return ctx.reply(settings.about_text || '🌟 VYRON Business Automation Bot.', { parse_mode: 'Markdown' });
      }

      if (text === '🤖 AI ASSISTANT') {
        stateManager.clear(fromId);
        aiService.startAiSession(fromId);
        return ctx.reply(
          '🤖 *Welcome to VYRON Business AI*\n\nI am your automated business assistant. Ask me anything about our products, Telegram bots, or referral earnings!',
          { parse_mode: 'Markdown', reply_markup: keyboards.aiReplyMenu() }
        );
      }

      if (text === '🔙 Exit AI Assistant' || text === '🔙 Back' || text === '🔙 Back to User Menu' || text === '🎛️ Menu') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const admin = await db.getAdmin(fromId);
        return ctx.reply('🏠 *Returned to Main Menu:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.fullMenu(Boolean(admin))
        });
      }

      if (text === '❌ Close Menu') {
        return ctx.reply('🎛️ Menu collapsed. Tap *🎛️ Menu* anytime to reopen.', {
          reply_markup: keyboards.fourButtonMenu()
        });
      }

      // AI Conversation Mode
      if (aiService.isAiActive(fromId) && text) {
        await ctx.replyWithChatAction('typing');
        const aiResponse = await aiService.generateAiResponse(fromId, text);
        return ctx.reply(aiResponse.text, { parse_mode: 'Markdown' }).catch(() => {
          return ctx.reply(aiResponse.text);
        });
      }

      // State Machine
      const state = stateManager.get(fromId);
      if (state) {
        if (state.step === 'awaiting_withdrawal_details' && text) {
          stateManager.clear(fromId);
          const withdrawal = await db.createWithdrawal(fromId, ctx.from.first_name, state.balance, text);
          return ctx.reply(`✅ *Withdrawal Request Submitted!*\n\nAmount: *₹${withdrawal.amount.toFixed(2)}*\nPayout Details: \`${text}\``, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.fullMenu()
          });
        }

        if (state.step === 'awaiting_ticket_subject' && text) {
          stateManager.clear(fromId);
          const ticket = await db.createSupportTicket({
            user_telegram_id: fromId,
            user_name: ctx.from.first_name,
            subject: text,
            messages: [{ sender: 'user', text, timestamp: new Date().toISOString() }]
          });
          return ctx.reply(`✅ *Ticket Created!*\n\nTicket Number: \`${ticket.ticket_number}\``, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.supportReplyMenu()
          });
        }

        if (state.step === 'awaiting_payment_proof' && (photo || text)) {
          stateManager.clear(fromId);
          const order = await db.getOrder(state.orderId);
          if (!order) return ctx.reply('⚠️ Order not found.');

          const fileId = photo ? photo.file_id : '';
          const utr = text || 'Photo Proof';

          await db.updateOrderPaymentProof(order.id, fileId, utr);
          await db.createPayment({
            order_id: order.id,
            user_telegram_id: fromId,
            transaction_id: utr,
            proof_file_id: fileId,
            amount: order.final_amount,
            status: 'pending'
          });

          return ctx.reply(`🎉 *Payment Proof Received!*\n\nOrder #:\`${order.order_number}\`\nWe will review your submission shortly!`, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.fullMenu()
          });
        }
      }
    } catch (err) {
      console.error('Error in message router:', err.message);
    }
  });

  // Callbacks
  bot.on('callback_query:data', async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;
      const fromId = ctx.from.id;
      await ctx.answerCallbackQuery().catch(() => {});

      if (data === 'noop') return;

      if (data === 'user:check_joined') {
        const hasJoined = await checkForceChannels(ctx);
        if (hasJoined) {
          const admin = await db.getAdmin(fromId);
          return ctx.reply('✅ *Access unlocked!*', {
            parse_mode: 'Markdown',
            reply_markup: keyboards.fullMenu(Boolean(admin))
          });
        }
        return;
      }

      if (data === 'user:products:list') {
        const products = await db.getProducts(true);
        return ctx.editMessageText('🛍️ *Select a Product:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.productListInline(products)
        });
      }

      if (data.startsWith('user:product:')) {
        const pid = data.replace('user:product:', '');
        const prod = await db.getProduct(pid);
        if (!prod) return ctx.reply('⚠️ Product not found.');
        const text = `🛍️ *${prod.name}*\n\n💵 *Price:* ₹${prod.price}\n📦 *Type:* ${prod.type?.toUpperCase()}\n\n📝 *Description:*\n${prod.description}\n\n🚀 *Delivery:* ${prod.delivery_info || 'Immediate'}`;
        return ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.productDetailInline(prod)
        });
      }

      if (data === 'user:services:list') {
        const services = await db.getServices(true);
        return ctx.editMessageText('🧑💻 *Select a Service:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.serviceListInline(services)
        });
      }

      if (data.startsWith('user:service:')) {
        const sid = data.replace('user:service:', '');
        const srv = await db.getService(sid);
        if (!srv) return ctx.reply('⚠️ Service not found.');
        const text = `🧑💻 *${srv.name}*\n\n💵 *Price:* ₹${srv.price}\n⏱️ *Turnaround:* ${srv.delivery_time || '24-48h'}\n\n📝 *Description:*\n${srv.description}`;
        return ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.serviceDetailInline(srv)
        });
      }

      if (data.startsWith('order:start:product:')) {
        const pid = data.replace('order:start:product:', '');
        const prod = await db.getProduct(pid);
        if (!prod) return ctx.reply('⚠️ Product not found.');

        const order = await db.createOrder({
          user_telegram_id: fromId,
          user_name: ctx.from.first_name,
          item_type: 'product',
          item_id: prod.id,
          item_name: prod.name,
          original_amount: prod.price,
          discount: 0,
          final_amount: prod.price,
          status: 'pending',
          delivery_info: prod.delivery_info
        });

        const settings = await db.getSettings();
        const msg =
          `🛒 *Order Generated!*\n\n` +
          `🆔 *Order #:* \`${order.order_number}\`\n` +
          `🛍️ *Item:* ${order.item_name}\n` +
          `💵 *Amount Due:* ₹${order.final_amount}\n\n` +
          `💳 *Payment Details:*\n` +
          `• *UPI ID:* \`${settings.upi_id || 'business@upi'}\`\n` +
          `• *Recipient:* ${settings.receiver_name || 'VYRON Business'}\n\n` +
          `Tap *💳 Submit Payment Proof* once paid:`;

        return ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.orderActions(order)
        });
      }

      if (data.startsWith('order:start:service:')) {
        const sid = data.replace('order:start:service:', '');
        const srv = await db.getService(sid);
        if (!srv) return ctx.reply('⚠️ Service not found.');

        const order = await db.createOrder({
          user_telegram_id: fromId,
          user_name: ctx.from.first_name,
          item_type: 'service',
          item_id: srv.id,
          item_name: srv.name,
          original_amount: srv.price,
          discount: 0,
          final_amount: srv.price,
          status: 'pending',
          delivery_info: srv.delivery_time
        });

        const settings = await db.getSettings();
        const msg =
          `🧑💻 *Service Order Generated!*\n\n` +
          `🆔 *Order #:* \`${order.order_number}\`\n` +
          `🧑💻 *Service:* ${order.item_name}\n` +
          `💵 *Amount Due:* ₹${order.final_amount}\n\n` +
          `💳 *Payment Details:*\n` +
          `• *UPI ID:* \`${settings.upi_id || 'business@upi'}\`\n` +
          `• *Recipient:* ${settings.receiver_name || 'VYRON Business'}\n\n` +
          `Tap *💳 Submit Payment Proof* once paid:`;

        return ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.orderActions(order)
        });
      }

      if (data.startsWith('order:pay:')) {
        const oid = data.replace('order:pay:', '');
        stateManager.set(fromId, { step: 'awaiting_payment_proof', orderId: oid });
        return ctx.reply('📸 Please send your *Payment Screenshot* or reply with your 12-digit *UTR / Transaction Number* now:');
      }

      if (data.startsWith('order:cancel:')) {
        const oid = data.replace('order:cancel:', '');
        await db.updateOrderStatus(oid, 'cancelled');
        return ctx.reply('❌ Order has been cancelled.');
      }
    } catch (err) {
      console.error('Error in callback query handler:', err.message);
    }
  });

  return bot;
}

// ==========================================
// 8. ROBUST RECONNECTING POLLING RUNNER
// ==========================================
let activeBot = null;

async function startLongPolling() {
  console.log('🚀 [Engine] Bootstrapping VYRON Business Bot in Long Polling mode...');
  await db.init();

  const bot = createTelegramBot();
  if (!bot) {
    console.log('ℹ️ Bot token missing. Set TELEGRAM_BOT_TOKEN to start polling.');
    return;
  }
  activeBot = bot;

  // Set official commands
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '🏠 Open VYRON Main Menu' },
      { command: 'menu', description: '📱 Navigation Menu' },
      { command: 'orders', description: '📦 My Orders & Tracking' },
      { command: 'ai', description: '🤖 VYRON AI Assistant' },
      { command: 'account', description: '👤 My Account Profile' },
      { command: 'support', description: '🎫 Customer Support Center' },
      { command: 'admin', description: '⚙️ Admin Control Panel' }
    ]);
  } catch (cmdErr) {
    console.warn('⚠️ Commands setup warning:', cmdErr.message);
  }

  // Delete any lingering webhook and drop pending backlogged updates
  try {
    console.log('🧹 [Polling] Clearing webhooks & dropping pending backlogged updates...');
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (whErr) {
    console.warn('⚠️ Delete webhook warning:', whErr.message);
  }

  // Persistent reconnect loop for long polling
  let isRunning = true;
  let retryCount = 0;

  const runPollingLoop = async () => {
    while (isRunning) {
      try {
        console.log('📡 [Polling] Starting long polling with drop_pending_updates: true...');
        await bot.start({
          drop_pending_updates: true,
          allowed_updates: ['message', 'callback_query'],
          onStart: (botInfo) => {
            retryCount = 0;
            console.log(`✅ [Polling] Bot @${botInfo.username} (${botInfo.first_name}) is online and actively polling!`);
          }
        });
      } catch (err) {
        const errorMsg = err?.message || String(err);
        const isConflict = errorMsg.includes('409') || errorMsg.includes('Conflict') || err?.error_code === 409;

        // Clean up runner state on failure
        try {
          await bot.stop();
        } catch {}

        if (isConflict) {
          // If another instance or lingering connection is open, wait 15 seconds for Telegram timeout window to close
          console.warn('⚠️ [409 Conflict] Telegram reported another getUpdates connection is open. Waiting 15s for the old connection to close before retrying...');
          await new Promise(r => setTimeout(r, 15000));
        } else {
          retryCount++;
          const backoffMs = Math.min(2000 * Math.pow(1.5, retryCount), 30000);
          console.error(`⚠️ [Polling Error] Polling interrupted (${errorMsg}). Reconnecting in ${Math.round(backoffMs / 1000)}s...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }
  };

  runPollingLoop();
}

// Graceful Shutdown
const shutdown = async (signal) => {
  console.log(`🛑 [Shutdown] Received ${signal}. Stopping bot cleanly...`);
  try {
    if (activeBot) {
      await activeBot.stop();
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
  startLongPolling();
});
