import express from 'express';
import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
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
// 1. SAFE PROCESS CRASH-PROOFING HANDLERS
// ==========================================
process.on('uncaughtException', (err) => {
  const timestamp = new Date().toISOString();
  console.error(`💥 [${timestamp}] [CRASH-PROOF] Uncaught Exception caught safely:`, {
    message: err.message,
    stack: err.stack,
    name: err.name
  });
});

process.on('unhandledRejection', (reason, promise) => {
  const timestamp = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  console.error(`⚠️ [${timestamp}] [CRASH-PROOF] Unhandled Rejection caught safely:`, {
    reason: msg,
    stack
  });
});

// ==========================================
// 2. CONFIGURATION & TOKEN RESOLUTION
// ==========================================
function resolveConfiguration() {
  let rawToken = process.env.TELEGRAM_BOT_TOKEN ? String(process.env.TELEGRAM_BOT_TOKEN).trim().replace(/^["']|["']$/g, '') : '';
  let rawAdminId = process.env.INITIAL_SUPER_ADMIN_ID ? String(process.env.INITIAL_SUPER_ADMIN_ID).trim().replace(/^["']|["']$/g, '') : '';

  // Auto-detect if secrets were accidentally swapped in host environment
  const isTokenFormat = (str) => /^\d{6,14}:[A-Za-z0-9_-]{25,}$/.test(str);
  const isNumericUserId = (str) => /^\d{5,14}$/.test(str);

  if (isTokenFormat(rawAdminId) && (isNumericUserId(rawToken) || !rawToken)) {
    console.log('🔄 [Config] Auto-swapping TELEGRAM_BOT_TOKEN and INITIAL_SUPER_ADMIN_ID to correct variables.');
    const temp = rawToken;
    rawToken = rawAdminId;
    rawAdminId = temp;
  }

  // Detect public base URL across various hosts (Render, Koyeb, Fly, Railway, etc.)
  const publicUrl = (
    process.env.APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.KOYEB_PUBLIC_DOMAIN ||
    process.env.PUBLIC_URL ||
    ''
  ).replace(/\/+$/, '');

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    telegramBotToken: rawToken,
    initialSuperAdminId: rawAdminId,
    webhookSecret: process.env.WEBHOOK_SECRET ? String(process.env.WEBHOOK_SECRET).trim() : '',
    appUrl: publicUrl,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    isProduction: process.env.NODE_ENV === 'production'
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
    this.recentProcessedUpdates = new Set();
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
      processed_updates: [],
      settings: {},
      analytics_events: [],
      referrals: [],
      withdrawals: [],
      force_channels: []
    };
  }

  async init() {
    if (this.isInitialized) return;

    // Check Firebase configuration
    let rawFirebaseConfig = null;
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      try {
        rawFirebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.warn('⚠️ Could not parse firebase-applet-config.json:', e.message);
      }
    } else if (process.env.FIREBASE_CONFIG) {
      try {
        rawFirebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
      } catch (e) {
        console.warn('⚠️ Could not parse process.env.FIREBASE_CONFIG:', e.message);
      }
    }

    if (rawFirebaseConfig) {
      try {
        console.log('🔥 [DB] Initializing Cloud Firestore...');
        const app = initializeApp(rawFirebaseConfig);
        this.firestoreDb = initializeFirestore(app, {}, rawFirebaseConfig.firestoreDatabaseId || '(default)');
        
        // Ping Firestore
        const pingRef = doc(this.firestoreDb, '_system_health', 'ping');
        await setDoc(pingRef, { timestamp: Date.now(), status: 'online' }, { merge: true });
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

    await this.seedDefaults();
    this.isInitialized = true;
  }

  initFileStore() {
    this.type = 'file';
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = { ...this.data, ...JSON.parse(raw) };
      } catch (err) {
        console.error('Error reading db.json:', err.message);
        this.saveFileStore();
      }
    } else {
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

  // --- Processed Updates Deduplication ---
  async isUpdateProcessed(updateId) {
    const uid = String(updateId);
    if (this.recentProcessedUpdates.has(uid)) return true;
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'processed_updates', uid));
        if (snap.exists()) {
          this.recentProcessedUpdates.add(uid);
          return true;
        }
      } catch {
        return false;
      }
    } else {
      const found = this.data.processed_updates?.some(u => String(u.update_id) === uid);
      if (found) {
        this.recentProcessedUpdates.add(uid);
        return true;
      }
    }
    return false;
  }

  async markUpdateProcessed(updateId) {
    const uid = String(updateId);
    this.recentProcessedUpdates.add(uid);
    if (this.recentProcessedUpdates.size > 2500) {
      const first = this.recentProcessedUpdates.values().next().value;
      this.recentProcessedUpdates.delete(first);
    }
    if (this.type === 'firestore') {
      try {
        await setDoc(doc(this.firestoreDb, 'processed_updates', uid), {
          update_id: Number(updateId),
          processed_at: new Date().toISOString()
        });
      } catch {}
    } else {
      if (!this.data.processed_updates) this.data.processed_updates = [];
      this.data.processed_updates.push({ update_id: Number(updateId), processed_at: new Date().toISOString() });
      if (this.data.processed_updates.length > 3000) {
        this.data.processed_updates = this.data.processed_updates.slice(-2000);
      }
      this.saveFileStore();
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
      await setDoc(doc(this.firestoreDb, 'admins', tid), payload, { merge: true });
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
      await deleteDoc(doc(this.firestoreDb, 'admins', tid));
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
      await setDoc(doc(this.firestoreDb, 'users', tid), payload, { merge: true });
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
      await setDoc(doc(this.firestoreDb, 'users', tid), { is_blocked: Boolean(isBlocked) }, { merge: true });
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
      await setDoc(doc(this.firestoreDb, 'products', String(product.id)), product, { merge: true });
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
      await deleteDoc(doc(this.firestoreDb, 'products', pid));
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
      await setDoc(doc(this.firestoreDb, 'services', String(service.id)), service, { merge: true });
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
      await deleteDoc(doc(this.firestoreDb, 'services', sid));
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

  async getEarningOpportunity(id) {
    const oid = String(id);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'earning_opportunities', oid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.earning_opportunities?.find(o => String(o.id) === oid) || null;
  }

  async saveEarningOpportunity(opportunity) {
    if (!opportunity.id) opportunity.id = 'earn_' + Date.now();
    opportunity.is_active = opportunity.is_active ?? true;
    opportunity.created_at = opportunity.created_at || new Date().toISOString();

    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'earning_opportunities', String(opportunity.id)), opportunity, { merge: true });
    } else {
      const idx = this.data.earning_opportunities.findIndex(o => String(o.id) === String(opportunity.id));
      if (idx >= 0) this.data.earning_opportunities[idx] = { ...this.data.earning_opportunities[idx], ...opportunity };
      else this.data.earning_opportunities.push(opportunity);
      this.saveFileStore();
    }
    this.invalidateCache('earning_opportunities');
    return opportunity;
  }

  async deleteEarningOpportunity(id) {
    const oid = String(id);
    if (this.type === 'firestore') {
      await deleteDoc(doc(this.firestoreDb, 'earning_opportunities', oid));
    } else {
      this.data.earning_opportunities = this.data.earning_opportunities.filter(o => String(o.id) !== oid);
      this.saveFileStore();
    }
    this.invalidateCache('earning_opportunities');
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

  async getCoupon(code) {
    const cCode = String(code).toUpperCase().trim();
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'coupons', cCode));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.coupons?.find(c => String(c.code).toUpperCase() === cCode) || null;
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
      await setDoc(doc(this.firestoreDb, 'coupons', cCode), payload, { merge: true });
    } else {
      const idx = this.data.coupons.findIndex(c => String(c.code).toUpperCase() === cCode);
      if (idx >= 0) this.data.coupons[idx] = { ...this.data.coupons[idx], ...payload };
      else this.data.coupons.push(payload);
      this.saveFileStore();
    }
    this.invalidateCache('coupons');
    return payload;
  }

  async deleteCoupon(code) {
    const cCode = String(code).toUpperCase().trim();
    if (this.type === 'firestore') {
      await deleteDoc(doc(this.firestoreDb, 'coupons', cCode));
    } else {
      this.data.coupons = this.data.coupons.filter(c => String(c.code).toUpperCase() !== cCode);
      this.saveFileStore();
    }
    this.invalidateCache('coupons');
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
      await setDoc(doc(this.firestoreDb, 'orders', String(order.id)), order, { merge: true });
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

  async getOrders(limitCount = 50, status = null) {
    if (this.type === 'firestore') {
      try {
        let q = collection(this.firestoreDb, 'orders');
        if (status) q = query(q, where('status', '==', status));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list.slice(0, limitCount);
      } catch {
        return [];
      }
    }
    let list = this.data.orders || [];
    if (status) list = list.filter(o => o.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limitCount);
  }

  async updateOrderStatus(id, status, deliveryInfo = '') {
    const oid = String(id);
    const order = await this.getOrder(oid);
    if (!order) return null;

    const updates = { status, updated_at: new Date().toISOString() };
    if (deliveryInfo) updates.delivery_info = deliveryInfo;

    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'orders', oid), updates, { merge: true });
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
      await setDoc(doc(this.firestoreDb, 'orders', oid), updates, { merge: true });
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
      await setDoc(doc(this.firestoreDb, 'payments', String(payment.id)), payment, { merge: true });
    } else {
      this.data.payments.push(payment);
      this.saveFileStore();
    }
    return payment;
  }

  async getPayment(id) {
    const pid = String(id);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'payments', pid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.payments?.find(p => String(p.id) === pid) || null;
  }

  async getPaymentByOrder(orderId) {
    const oid = String(orderId);
    if (this.type === 'firestore') {
      try {
        const q = query(collection(this.firestoreDb, 'payments'), where('order_id', '==', oid), firestoreLimit(1));
        const snap = await getDocs(q);
        let found = null;
        snap.forEach(d => { found = d.data(); });
        return found;
      } catch {
        return null;
      }
    }
    return this.data.payments?.find(p => String(p.order_id) === oid) || null;
  }

  async getPayments(status = null) {
    if (this.type === 'firestore') {
      try {
        let q = collection(this.firestoreDb, 'payments');
        if (status) q = query(q, where('status', '==', status));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    let list = this.data.payments || [];
    if (status) list = list.filter(p => p.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async updatePaymentStatus(id, status, adminNote = '') {
    const pid = String(id);
    const updates = { status, admin_note: adminNote, reviewed_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'payments', pid), updates, { merge: true });
    } else {
      const payment = this.data.payments?.find(p => String(p.id) === pid);
      if (payment) {
        payment.status = status;
        payment.admin_note = adminNote;
        payment.reviewed_at = new Date().toISOString();
        this.saveFileStore();
      }
    }
    return await this.getPayment(pid);
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
      await setDoc(doc(this.firestoreDb, 'support_tickets', String(ticket.id)), ticket);
    } else {
      this.data.support_tickets.push(ticket);
      this.saveFileStore();
    }
    return ticket;
  }

  async getSupportTicket(id) {
    const tid = String(id);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'support_tickets', tid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.support_tickets?.find(t => String(t.id) === tid) || null;
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

  async getSupportTickets(status = null) {
    if (this.type === 'firestore') {
      try {
        let q = collection(this.firestoreDb, 'support_tickets');
        if (status) q = query(q, where('status', '==', status));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    let list = this.data.support_tickets || [];
    if (status) list = list.filter(t => t.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async addTicketMessage(ticketId, senderOrMessage, maybeText) {
    const tid = String(ticketId);
    const ticket = await this.getSupportTicket(tid);
    if (!ticket) return null;

    let msgObj;
    let newStatus = ticket.status;
    if (typeof senderOrMessage === 'string' && maybeText !== undefined) {
      msgObj = { sender: senderOrMessage, text: maybeText, timestamp: new Date().toISOString() };
      if (senderOrMessage === 'admin') newStatus = 'answered';
    } else if (typeof senderOrMessage === 'object' && senderOrMessage !== null) {
      msgObj = { ...senderOrMessage, timestamp: senderOrMessage.timestamp || new Date().toISOString() };
      if (senderOrMessage.sender === 'admin') newStatus = 'answered';
    } else {
      msgObj = { text: String(senderOrMessage), timestamp: new Date().toISOString() };
    }

    const msgs = Array.isArray(ticket.messages) ? ticket.messages : [];
    msgs.push(msgObj);

    const updates = { messages: msgs, status: newStatus, updated_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'support_tickets', tid), updates, { merge: true });
    } else {
      const idx = this.data.support_tickets.findIndex(t => String(t.id) === tid);
      if (idx >= 0) this.data.support_tickets[idx] = { ...this.data.support_tickets[idx], ...updates };
      this.saveFileStore();
    }
    return { ...ticket, ...updates };
  }

  async updateTicketStatus(ticketId, status) {
    const tid = String(ticketId);
    const updates = { status, updated_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'support_tickets', tid), updates, { merge: true });
    } else {
      const idx = this.data.support_tickets.findIndex(t => String(t.id) === tid);
      if (idx >= 0) this.data.support_tickets[idx] = { ...this.data.support_tickets[idx], ...updates };
      this.saveFileStore();
    }
    return await this.getSupportTicket(tid);
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
      await setDoc(doc(this.firestoreDb, 'settings', 'global_config'), payload, { merge: true });
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

  async saveForceChannel(channel) {
    if (!channel.id) channel.id = 'fc_' + Date.now();
    channel.is_active = channel.is_active ?? true;
    channel.created_at = channel.created_at || new Date().toISOString();

    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'force_channels', String(channel.id)), channel, { merge: true });
    } else {
      const idx = this.data.force_channels.findIndex(c => String(c.id) === String(channel.id));
      if (idx >= 0) this.data.force_channels[idx] = { ...this.data.force_channels[idx], ...channel };
      else this.data.force_channels.push(channel);
      this.saveFileStore();
    }
    this.invalidateCache('force_channels');
    return channel;
  }

  async deleteForceChannel(id) {
    const cid = String(id);
    if (this.type === 'firestore') {
      await deleteDoc(doc(this.firestoreDb, 'force_channels', cid));
    } else {
      this.data.force_channels = this.data.force_channels.filter(c => String(c.id) !== cid);
      this.saveFileStore();
    }
    this.invalidateCache('force_channels');
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
      await setDoc(doc(this.firestoreDb, 'referrals', referralDoc.id), referralDoc);
    } else {
      if (!this.data.referrals) this.data.referrals = [];
      this.data.referrals.push(referralDoc);
      this.saveFileStore();
    }

    return { success: true, reward, newBalance, referrerId: refId };
  }

  async recordReferralCommission(referrerId, referredId, orderId, orderNumber, amount) {
    const refId = String(referrerId);
    const referrer = await this.getUser(refId);
    if (!referrer) return null;

    const commissionAmt = Number(amount);
    const newBalance = Number(referrer.withdrawable_balance || 0) + commissionAmt;

    await this.upsertUser({ telegram_id: refId, withdrawable_balance: newBalance });

    const referralDoc = {
      id: 'ref_comm_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      referrer_id: refId,
      referred_id: String(referredId),
      type: 'commission',
      amount: commissionAmt,
      order_id: String(orderId),
      order_number: String(orderNumber),
      created_at: new Date().toISOString()
    };

    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'referrals', referralDoc.id), referralDoc);
    } else {
      if (!this.data.referrals) this.data.referrals = [];
      this.data.referrals.push(referralDoc);
      this.saveFileStore();
    }

    return { success: true, commissionAmt, newBalance, referrerId: refId };
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
      await setDoc(doc(this.firestoreDb, 'withdrawals', withdrawal.id), withdrawal);
    } else {
      if (!this.data.withdrawals) this.data.withdrawals = [];
      this.data.withdrawals.push(withdrawal);
      this.saveFileStore();
    }
    return withdrawal;
  }

  async getWithdrawals(status = null) {
    if (this.type === 'firestore') {
      try {
        let q = collection(this.firestoreDb, 'withdrawals');
        if (status) q = query(q, where('status', '==', status));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push(d.data()));
        list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return list;
      } catch {
        return [];
      }
    }
    let list = this.data.withdrawals || [];
    if (status) list = list.filter(w => w.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getWithdrawal(id) {
    const wid = String(id);
    if (this.type === 'firestore') {
      try {
        const snap = await getDoc(doc(this.firestoreDb, 'withdrawals', wid));
        return snap.exists() ? snap.data() : null;
      } catch {
        return null;
      }
    }
    return this.data.withdrawals?.find(w => String(w.id) === wid) || null;
  }

  async updateWithdrawalStatus(id, status, reason = '') {
    const wid = String(id);
    const withdrawal = await this.getWithdrawal(wid);
    if (!withdrawal) return null;

    if (status === 'rejected' && withdrawal.status === 'pending') {
      const user = await this.getUser(withdrawal.user_telegram_id);
      if (user) {
        const refunded = Number(user.withdrawable_balance || 0) + Number(withdrawal.amount);
        await this.upsertUser({ telegram_id: user.telegram_id, withdrawable_balance: refunded });
      }
    }

    const updates = { status, admin_reason: reason, reviewed_at: new Date().toISOString() };
    if (this.type === 'firestore') {
      await setDoc(doc(this.firestoreDb, 'withdrawals', wid), updates, { merge: true });
    } else {
      const idx = this.data.withdrawals.findIndex(w => String(w.id) === wid);
      if (idx >= 0) this.data.withdrawals[idx] = { ...this.data.withdrawals[idx], ...updates };
      this.saveFileStore();
    }
    return { ...withdrawal, ...updates };
  }

  async getDashboardStats() {
    const [users, orders, payments, products, services] = await Promise.all([
      this.getUsers(),
      this.getOrders(500),
      this.getPayments(),
      this.getProducts(),
      this.getServices()
    ]);

    const completedOrders = orders.filter(o => o.status === 'completed');
    const totalSales = completedOrders.reduce((sum, o) => sum + Number(o.final_amount || 0), 0);
    const pendingOrders = orders.filter(o => o.status === 'pending').length;
    const pendingPayments = payments.filter(p => p.status === 'pending').length;

    return {
      totalUsers: users.length,
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
      totalSales,
      pendingOrders,
      pendingPayments,
      totalProducts: products.length,
      totalServices: services.length
    };
  }
}

export const db = new DatabaseEngine();

// ==========================================
// 4. UI & KEYBOARD BUILDERS
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
        [
          { text: '📊 Earnings History', style: 'primary' },
          { text: 'ℹ️ How It Works', style: 'primary' }
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

  aiReplyActions() {
    return {
      inline_keyboard: [[{ text: '🔙 Exit AI Assistant', callback_data: 'ai:exit' }]]
    };
  },

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
      ],
      [
        { text: '💸 Withdrawals', style: 'success' }
      ]
    ];
    if (isSuperAdmin) {
      keyboard.push([{ text: '👑 Admin Management', style: 'danger' }]);
    }
    keyboard.push([
      { text: '⚙️ Settings', style: 'primary' },
      { text: '🔙 Back to User Menu', style: 'danger' }
    ]);
    return { keyboard, resize_keyboard: true };
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

  async generateAiResponse(userId, prompt, userContext = {}) {
    const [products, services, opps, settings] = await Promise.all([
      db.getProducts(true),
      db.getServices(true),
      db.getEarningOpportunities(true),
      db.getSettings()
    ]);

    const catalogKnowledge = `
VYRON BUSINESS INFO:
About: ${settings.about_text || 'Premium business services, digital products, and earning programs.'}
UPI ID for payments: ${settings.upi_id || 'business@upi'} (${settings.receiver_name || 'VYRON Business'})

Available Products:
${products.map(p => `- ${p.name} (₹${p.price}): ${p.description}`).join('\n') || 'None'}

Available Services:
${services.map(s => `- ${s.name} (₹${s.price}) [Turnaround: ${s.delivery_time || '24-48h'}]: ${s.description}`).join('\n') || 'None'}

Earning Opportunities:
${opps.map(o => `- ${o.name}: ${o.reward_info} - ${o.how_to_earn}`).join('\n') || 'None'}
`;

    if (!this.aiInstance) {
      // Smart offline fallback assistant
      const lower = prompt.toLowerCase();
      if (lower.includes('product') || lower.includes('buy') || lower.includes('toolkit') || lower.includes('book')) {
        return { text: `🛍️ *VYRON Catalog Products:*\n\n` + products.map(p => `• *${p.name}* — ₹${p.price}\n  _${p.description}_`).join('\n\n') + `\n\nTap *🛍️ Products* in the menu to order!` };
      }
      if (lower.includes('service') || lower.includes('bot') || lower.includes('custom') || lower.includes('setup')) {
        return { text: `🧑💻 *Professional Business Services:*\n\n` + services.map(s => `• *${s.name}* — ₹${s.price}\n  _${s.description}_`).join('\n\n') + `\n\nTap *🧑💻 Services* in the menu to book!` };
      }
      if (lower.includes('earn') || lower.includes('refer') || lower.includes('money') || lower.includes('commission')) {
        return { text: `💰 *Earn Money with VYRON:*\n\n• Get *₹2 instant bonus* for every invited member.\n• Earn *20% lifetime commission* on all purchases.\n• Request payout anytime to UPI.\n\nTap *💰 Earn Money* to grab your link!` };
      }
      return { text: `🤖 *VYRON AI Assistant:*\n\nI can help you explore our products, custom Telegram bot services, referral earnings, and orders.\n\nType your question or choose an option from the main menu below!` };
    }

    try {
      const systemInstruction = `You are VYRON AI, the friendly, professional, and concise customer assistant for VYRON Business.
Answer customer queries accurately using the provided catalog information.
Keep responses concise, polite, beautifully formatted with Telegram Markdown, and guide them on how to order or earn.
${catalogKnowledge}`;

      const response = await this.aiInstance.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.7,
          maxOutputTokens: 500
        }
      });

      return { text: response.text || 'How else can I assist you with VYRON services today?' };
    } catch (err) {
      console.warn('⚠️ Gemini generation error:', err.message);
      return { text: `🤖 *VYRON AI Assistant:*\n\nWe offer premium business toolkits, custom Telegram bot engineering, and affiliate income programs.\n\nHow can I help you today?` };
    }
  }
}
const aiService = new AiService();

// ==========================================
// 7. GRAMMY TELEGRAM BOT FACTORY
// ==========================================
let botInstance = null;

export function initTelegramBot() {
  if (botInstance) return botInstance;
  if (!config.telegramBotToken) {
    console.warn('⚠️ [Bot] TELEGRAM_BOT_TOKEN is not configured yet.');
    return null;
  }

  const bot = new Bot(config.telegramBotToken);

  // Global safe error handler inside grammY
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`💥 [grammY] Error handling update ${ctx?.update?.update_id || 'unknown'}:`, err.error?.message || err.message);
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

  // ----------------------------------------
  // BOT COMMANDS & HANDLERS
  // ----------------------------------------

  // /start
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

  // /menu
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

  // /orders
  bot.command('orders', async (ctx) => {
    try {
      const orders = await db.getUserOrders(ctx.from.id);
      if (orders.length === 0) {
        return ctx.reply('📦 You have no active orders yet. Browse *🛍️ Products* or *🧑💻 Services* to place your first order!', {
          parse_mode: 'Markdown'
        });
      }
      let msg = `📦 *Your Recent Orders (${orders.length}):*\n\n`;
      orders.slice(0, 5).forEach((o, i) => {
        const statusEmoji = o.status === 'completed' ? '✅' : o.status === 'processing' ? '⚙️' : '⏳';
        msg += `${i + 1}. *${o.item_name}*\n   🆔 \`${o.order_number}\` | 💵 ₹${o.final_amount} | ${statusEmoji} *${o.status.toUpperCase()}*\n\n`;
      });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Error in /orders:', e.message);
    }
  });

  // /ai
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

  // /account
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
        `📦 *Total Orders:* ${orders.length}\n` +
        `📅 *Joined:* ${user?.joined_at ? new Date(user.joined_at).toLocaleDateString() : 'Today'}`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Error in /account:', e.message);
    }
  });

  // /support
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

  // /admin
  bot.command('admin', async (ctx) => {
    try {
      const admin = await db.getAdmin(ctx.from.id);
      if (!admin) {
        return ctx.reply('⛔ *Access Denied:* You do not have administrator permissions.', { parse_mode: 'Markdown' });
      }
      const isSuper = admin.role === 'super_admin' || String(ctx.from.id) === String(config.initialSuperAdminId);
      const stats = await db.getDashboardStats();

      const msg =
        `⚙️ *VYRON Executive Admin Control Panel*\n\n` +
        `👑 *Role:* ${admin.role?.toUpperCase() || 'ADMIN'}\n` +
        `👥 *Users:* ${stats.totalUsers} | 📦 *Orders:* ${stats.totalOrders}\n` +
        `⏳ *Pending Orders:* ${stats.pendingOrders} | 💳 *Pending Payments:* ${stats.pendingPayments}\n` +
        `💵 *Total Revenue:* ₹${stats.totalSales}\n\n` +
        `Select an administrative module below:`;

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: keyboards.adminReplyMenu(isSuper)
      });
    } catch (e) {
      console.error('Error in /admin:', e.message);
    }
  });

  // ----------------------------------------
  // MESSAGE TEXT & BOTTOM KEYBOARDS ROUTER
  // ----------------------------------------
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

      // Handle Bottom Reply Keyboard Clicks
      if (text === '🛍️ Products') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const products = await db.getProducts(true);
        if (products.length === 0) return ctx.reply('🛍️ No products currently in catalog.');
        return ctx.reply('🛍️ *Select a Product to View Details:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.productListInline(products)
        });
      }

      if (text === '🧑💻 Services') {
        stateManager.clear(fromId);
        aiService.exitAiSession(fromId);
        const services = await db.getServices(true);
        if (services.length === 0) return ctx.reply('🧑💻 No services currently listed.');
        return ctx.reply('🧑💻 *Select a Professional Service:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboards.serviceListInline(services)
        });
      }

      if (text === '💰 Earn Money' || text === '💰 My Earnings' || text === '💰 Balance') {
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
          return ctx.reply(`⚠️ Minimum withdrawal amount is *₹50.00*. Your current balance is *₹${bal.toFixed(2)}*. Keep sharing your referral link!`, {
            parse_mode: 'Markdown'
          });
        }
        stateManager.set(fromId, { step: 'awaiting_withdrawal_details', balance: bal });
        return ctx.reply(`💸 *Request Payout (Balance: ₹${bal.toFixed(2)})*\n\nPlease reply with your *UPI ID* or *Bank Transfer Details* (e.g., \`username@upi\`):`, {
          parse_mode: 'Markdown'
        });
      }

      if (text === '🎁 Offers' || text === '🎁 Active Coupons') {
        const coupons = await db.getCoupons(true);
        if (coupons.length === 0) return ctx.reply('🎁 No promotional coupons currently active.');
        let msg = `🎁 *Active Discount Coupons:*\n\n`;
        coupons.forEach(c => {
          const discount = c.discount_type === 'percent' ? `${c.discount_value}% OFF` : `₹${c.discount_value} OFF`;
          msg += `🎟️ Code: \`${c.code}\` — *${discount}*\n   _${c.description}_\n\n`;
        });
        msg += `Apply coupon codes during checkout!`;
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === '📦 Orders' || text === '📦 My Orders') {
        const orders = await db.getUserOrders(fromId);
        if (orders.length === 0) return ctx.reply('📦 You have no orders yet.');
        let msg = `📦 *Your Order History:*\n\n`;
        orders.slice(0, 5).forEach((o, i) => {
          msg += `${i + 1}. *${o.item_name}*\n   🆔 \`${o.order_number}\` | 💵 ₹${o.final_amount} | Status: *${o.status.toUpperCase()}*\n\n`;
        });
        return ctx.reply(msg, { parse_mode: 'Markdown' });
      }

      if (text === '👤 Account' || text === '👤 My Account') {
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
        return ctx.reply('✍️ Please type a brief description or message for your support ticket:');
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

      if (text === '🤖 AI ASSISTANT' || text === '🤖 AI Assistant') {
        stateManager.clear(fromId);
        aiService.startAiSession(fromId);
        return ctx.reply(
          '🤖 *Welcome to VYRON Business AI*\n\nI am your automated business assistant. Ask me anything about our products, custom Telegram bot engineering, or referral earnings!',
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

      // ----------------------------------------
      // Active AI Conversation Mode Handling
      // ----------------------------------------
      if (aiService.isAiActive(fromId) && text) {
        await ctx.replyWithChatAction('typing');
        const aiResponse = await aiService.generateAiResponse(fromId, text, {
          username: ctx.from.username,
          first_name: ctx.from.first_name
        });
        return ctx.reply(aiResponse.text, {
          parse_mode: 'Markdown',
          reply_markup: keyboards.aiReplyActions()
        }).catch(() => {
          return ctx.reply(aiResponse.text, { reply_markup: keyboards.aiReplyActions() });
        });
      }

      // ----------------------------------------
      // State Machine Handlers (Multi-step forms)
      // ----------------------------------------
      const state = stateManager.get(fromId);
      if (state) {
        // 1. Withdrawal Submission
        if (state.step === 'awaiting_withdrawal_details' && text) {
          stateManager.clear(fromId);
          const withdrawal = await db.createWithdrawal(fromId, ctx.from.first_name, state.balance, text);
          return ctx.reply(`✅ *Withdrawal Request Submitted!*\n\nAmount: *₹${withdrawal.amount.toFixed(2)}*\nPayout Details: \`${text}\`\n\nOur team will process your payout within 24 hours.`, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.fullMenu()
          });
        }

        // 2. Ticket Creation
        if (state.step === 'awaiting_ticket_subject' && text) {
          stateManager.clear(fromId);
          const ticket = await db.createSupportTicket({
            user_telegram_id: fromId,
            user_name: ctx.from.first_name,
            subject: text,
            messages: [{ sender: 'user', text, timestamp: new Date().toISOString() }]
          });
          return ctx.reply(`✅ *Ticket Created!*\n\nTicket Number: \`${ticket.ticket_number}\`\nOur support team will review your inquiry shortly.`, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.supportReplyMenu()
          });
        }

        // 3. Payment Proof Upload
        if (state.step === 'awaiting_payment_proof' && (photo || text)) {
          stateManager.clear(fromId);
          const order = await db.getOrder(state.orderId);
          if (!order) return ctx.reply('⚠️ Order not found.');

          const fileId = photo ? photo.file_id : '';
          const utr = text || 'UTR submitted in image';

          await db.updateOrderPaymentProof(order.id, fileId, utr);
          await db.createPayment({
            order_id: order.id,
            user_telegram_id: fromId,
            transaction_id: utr,
            proof_file_id: fileId,
            amount: order.final_amount,
            status: 'pending'
          });

          return ctx.reply(`🎉 *Payment Proof Received!*\n\nOrder #:\`${order.order_number}\`\nOur admin team has been notified and will verify your payment shortly!`, {
            parse_mode: 'Markdown',
            reply_markup: keyboards.fullMenu()
          });
        }
      }
    } catch (err) {
      console.error('Error in message router:', err.message);
    }
  });

  // ----------------------------------------
  // INLINE CALLBACK QUERIES ROUTER
  // ----------------------------------------
  bot.on('callback_query:data', async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;
      const fromId = ctx.from.id;
      await ctx.answerCallbackQuery().catch(() => {});

      if (data === 'noop') return;

      if (data === 'ai:exit') {
        aiService.exitAiSession(fromId);
        const admin = await db.getAdmin(fromId);
        return ctx.reply('👋 Exited AI Assistant.', { reply_markup: keyboards.fullMenu(Boolean(admin)) });
      }

      if (data === 'user:check_joined') {
        const hasJoined = await checkForceChannels(ctx);
        if (hasJoined) {
          const admin = await db.getAdmin(fromId);
          return ctx.reply('✅ *Thank you for joining! Access unlocked.*', {
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
        const text = `🧑💻 *${srv.name}*\n\n💵 *Price:* ₹${srv.price}\n⏱️ *Turnaround:* ${srv.delivery_time || '24-48h'}\n\n📝 *Description:*\n${srv.description}\n\n📋 *Requirements:* ${srv.requirements || 'Standard'}`;
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
          `Please tap *💳 Submit Payment Proof* once paid:`;

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
          `Tap *💳 Submit Payment Proof* after completing transaction:`;

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

  botInstance = bot;
  return botInstance;
}

// ==========================================
// 8. EXPRESS SERVER INITIALIZATION
// ==========================================
const app = express();
app.use(express.json());

let isReady = false;
let botInfo = null;
let activeMode = 'initializing';

// ------------------------------------------
// Webhook Endpoint (POST /api/telegram-webhook & /webhook & /)
// ------------------------------------------
const handleIncomingTelegramWebhook = async (req, res) => {
  // 1. Secret Token Security Validation
  if (config.webhookSecret) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== config.webhookSecret) {
      console.warn('⛔ [Webhook] Invalid secret token received');
      return res.status(403).json({ error: 'Unauthorized' });
    }
  }

  const update = req.body;
  if (!update || !update.update_id) {
    return res.status(400).send('Bad Request: Missing update_id');
  }

  // 2. CRITICAL: Return 200 OK IMMEDIATELY to Telegram so webhook never times out
  res.status(200).json({ ok: true });

  // 3. Process the update asynchronously in the background
  setImmediate(async () => {
    try {
      const alreadyHandled = await db.isUpdateProcessed(update.update_id);
      if (alreadyHandled) return;

      await db.markUpdateProcessed(update.update_id);
      const bot = initTelegramBot();
      if (bot) {
        await bot.handleUpdate(update);
      }
    } catch (err) {
      console.error(`❌ [Webhook-Async] Error handling update ${update.update_id}:`, err.message);
    }
  });
};

app.post('/api/telegram-webhook', handleIncomingTelegramWebhook);
app.post('/webhook', handleIncomingTelegramWebhook);
app.post('/', (req, res, next) => {
  if (req.body && req.body.update_id) return handleIncomingTelegramWebhook(req, res);
  next();
});

// ------------------------------------------
// 9. KEEP-ALIVE HEALTH ENDPOINT (GET /health)
// ------------------------------------------
app.get('/health', async (req, res) => {
  const mem = process.memoryUsage();
  const isDbConnected = db.isInitialized;
  const isHealthy = isReady && isDbConnected;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    bot: botInfo ? `@${botInfo.username}` : 'pending_credentials',
    database: isDbConnected ? db.type : 'connecting',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`
    },
    mode: activeMode,
    appUrl: config.appUrl || 'auto-detected'
  });
});

app.get('/api/status', async (req, res) => {
  const stats = await db.getDashboardStats();
  res.json({
    status: 'online',
    botInfo,
    databaseType: db.type,
    stats,
    appUrl: config.appUrl
  });
});

// ------------------------------------------
// Operational UI Dashboard (GET /)
// ------------------------------------------
app.get('/', async (req, res) => {
  const stats = await db.getDashboardStats();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VYRON Business Bot - 24/7 Production Controller</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased p-6 md:p-12">
  <div class="max-w-4xl mx-auto space-y-6">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-6 gap-4">
      <div class="flex items-center gap-3">
        <span class="text-4xl">🤖</span>
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-white">VYRON Business Bot</h1>
          <p class="text-slate-400 text-sm">24/7 Crash-Proof Webhook Server & Engine</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="px-3 py-1 rounded-full text-xs font-semibold ${botInfo ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}">
          ● ${botInfo ? 'Bot Online (@' + botInfo.username + ')' : 'Connecting Bot'}
        </span>
        <span class="px-3 py-1 rounded-full text-xs font-semibold bg-blue-950 text-blue-400 border border-blue-800">
          DB: ${db.type.toUpperCase()}
        </span>
      </div>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs">Registered Members</div>
        <div class="text-2xl font-bold text-white mt-1">${stats.totalUsers}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs">Total Orders</div>
        <div class="text-2xl font-bold text-white mt-1">${stats.totalOrders}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs">Pending Review</div>
        <div class="text-2xl font-bold text-amber-400 mt-1">${stats.pendingOrders + stats.pendingPayments}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div class="text-slate-400 text-xs">Gross Revenue</div>
        <div class="text-2xl font-bold text-emerald-400 mt-1">₹${stats.totalSales}</div>
      </div>
    </div>

    <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-3">
      <h2 class="text-lg font-semibold text-white">⚡ Keep-Alive & Webhook Status</h2>
      <p class="text-xs text-slate-400 leading-relaxed">
        Immediate 200 OK responses prevent Telegram webhook timeouts, while the 10-minute self-ping heartbeat guarantees continuous 24/7 uptime on cloud providers.
      </p>
      <div class="pt-2 flex gap-3">
        <a href="/health" target="_blank" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors">
          Inspect /health Endpoint
        </a>
      </div>
    </div>
  </div>
</body>
</html>`;
  res.send(html);
});

// ==========================================
// 10. AUTOMATIC KEEP-ALIVE SELF-PING HEARTBEAT
// ==========================================
function setupKeepAliveHeartbeat(port) {
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  setInterval(() => {
    try {
      const localUrl = `http://127.0.0.1:${port}/health`;
      http.get(localUrl, (res) => {
        res.resume();
      }).on('error', (e) => {
        // Safe keep-alive silent catch
      });

      // If public URL is set, ping public endpoint to wake host proxy
      if (config.appUrl && config.appUrl.startsWith('https://') && !config.appUrl.includes('localhost')) {
        https.get(`${config.appUrl}/health`, (res) => {
          res.resume();
        }).on('error', () => {});
      }
    } catch (e) {
      // Safe catch
    }
  }, INTERVAL_MS);

  console.log('⏰ [Keep-Alive] Self-ping heartbeat scheduled every 10 minutes.');
}

// ==========================================
// 11. BOOTSTRAP & STARTUP
// ==========================================
async function startServer() {
  console.log('🚀 [Server] Starting VYRON Business Bot production server...');
  await db.init();

  const bot = initTelegramBot();
  if (bot) {
    try {
      await bot.init();
      botInfo = bot.botInfo;
      console.log(`🤖 [Telegram] Bot Authenticated: @${botInfo.username} (${botInfo.first_name})`);

      // Set official Telegram Bot Menu & Commands
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
        await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
      } catch (cmdErr) {
        console.warn('⚠️ Could not set bot menu commands:', cmdErr.message);
      }

      // Check URL and deployment mode
      const isPublicProductionUrl = config.appUrl &&
        config.appUrl.startsWith('https://') &&
        !config.appUrl.includes('localhost') &&
        !config.appUrl.includes('ais-dev-');

      if (isPublicProductionUrl) {
        activeMode = 'webhook';
        const webhookUrl = `${config.appUrl}/api/telegram-webhook`;
        console.log(`🌐 [Webhook] Registering Telegram Webhook: ${webhookUrl}`);
        const opts = { drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] };
        if (config.webhookSecret) opts.secret_token = config.webhookSecret;
        await bot.api.setWebhook(webhookUrl, opts);
        console.log('✅ [Webhook] Webhook registered successfully!');
      } else {
        // AI Studio dev environment or no public URL yet: enable background polling
        activeMode = 'polling';
        console.log('📡 [Polling] Starting interactive polling mode...');
        bot.start({
          drop_pending_updates: false,
          onStart: (info) => console.log(`🚀 [Polling] Bot @${info.username} is polling for updates.`)
        });
      }
    } catch (err) {
      console.error('⚠️ [Bot] Initialization warning:', err.message);
    }
  } else {
    console.log('ℹ️ [Server] Bot token pending. Provide TELEGRAM_BOT_TOKEN to activate bot.');
  }

  isReady = true;

  const listenPort = process.env.PORT || config.port || 3000;
  app.listen(listenPort, '0.0.0.0', () => {
    console.log(`📡 [Server] VYRON Server listening on port ${listenPort}`);
    console.log(`🩺 [Health] Health endpoint ready at http://localhost:${listenPort}/health`);
    setupKeepAliveHeartbeat(listenPort);
  });
}

startServer().catch((err) => {
  console.error('Fatal startup error:', err);
});
