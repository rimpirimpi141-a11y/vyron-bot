import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { config } from '../config.js';
import { FirestoreStore } from './firestore.js';

const { Pool } = pg;

class Database {
  constructor() {
    this.type = 'file'; // 'firestore', 'postgres', or 'file'
    this.firestoreStore = null;
    this.pool = null;
    this.filePath = path.resolve(process.cwd(), 'data', 'db.json');
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
    this.isInitialized = false;
  }

  async init() {
    if (this.isInitialized) return;

    // 1. Prioritize Cloud Firestore (Persistent Google Cloud serverless database)
    const hasFirebase = fs.existsSync(path.resolve(process.cwd(), 'firebase-applet-config.json')) || process.env.FIREBASE_CONFIG;
    if (hasFirebase) {
      try {
        console.log('🔥 Initializing Google Cloud Firestore persistence...');
        this.firestoreStore = new FirestoreStore();
        await this.firestoreStore.init();
        this.type = 'firestore';
        console.log('✅ Google Cloud Firestore connected and active.');

        // Migrate existing records from local db.json if available
        await this.firestoreStore.migrateFromFileStore(this.filePath);
      } catch (fErr) {
        console.warn('⚠️ Firestore initialization encountered an issue, falling back:', fErr.message);
      }
    }

    // 2. Fall back to PostgreSQL if configured
    if (this.type !== 'firestore') {
      if (config.databaseUrl) {
        try {
          console.log('🔗 Connecting to PostgreSQL database...');
          this.pool = new Pool({
            connectionString: config.databaseUrl,
            ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
          });
          await this.initPostgresSchema();
          this.type = 'postgres';
          console.log('✅ PostgreSQL connected and schema verified.');
        } catch (err) {
          console.error('⚠️ PostgreSQL connection failed, falling back to persistent file store:', err.message);
          this.initFileStore();
        }
      } else {
        console.log('📁 Initializing atomic persistent file store.');
        this.initFileStore();
      }
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
        const parsed = JSON.parse(raw);
        this.data = { ...this.data, ...parsed };
      } catch (err) {
        console.error('Error reading db.json, creating fresh store:', err.message);
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
      console.error('Failed to save file store:', err.message);
    }
  }

  async initPostgresSchema() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          telegram_id TEXT UNIQUE NOT NULL,
          username TEXT,
          first_name TEXT,
          is_blocked BOOLEAN DEFAULT FALSE,
          withdrawable_balance NUMERIC(10, 2) DEFAULT 0,
          referral_count INTEGER DEFAULT 0,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS admins (
          id SERIAL PRIMARY KEY,
          telegram_id TEXT UNIQUE NOT NULL,
          username TEXT,
          role TEXT DEFAULT 'admin',
          permissions JSONB DEFAULT '[]'::jsonb,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_by TEXT
        );

        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          price NUMERIC(10, 2) NOT NULL,
          type TEXT DEFAULT 'physical',
          stock INTEGER DEFAULT 0,
          is_unlimited BOOLEAN DEFAULT FALSE,
          delivery_info TEXT,
          image_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS services (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          price NUMERIC(10, 2) NOT NULL,
          delivery_time TEXT,
          requirements TEXT,
          image_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS earning_opportunities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          reward_info TEXT,
          how_to_earn TEXT,
          external_url TEXT,
          referral_info TEXT,
          terms TEXT,
          image_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS coupons (
          code TEXT PRIMARY KEY,
          description TEXT,
          discount_type TEXT DEFAULT 'percent',
          discount_value NUMERIC(10, 2) NOT NULL,
          expiry_date TIMESTAMP,
          usage_limit INTEGER DEFAULT 0,
          times_used INTEGER DEFAULT 0,
          applicable_to TEXT DEFAULT 'all',
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          order_number TEXT UNIQUE NOT NULL,
          user_telegram_id TEXT NOT NULL,
          user_name TEXT,
          item_type TEXT NOT NULL,
          item_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          original_amount NUMERIC(10, 2) NOT NULL,
          discount NUMERIC(10, 2) DEFAULT 0,
          final_amount NUMERIC(10, 2) NOT NULL,
          status TEXT DEFAULT 'pending',
          requirements TEXT,
          delivery_info TEXT,
          payment_proof_file_id TEXT,
          utr_number TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          user_telegram_id TEXT NOT NULL,
          transaction_id TEXT,
          proof_file_id TEXT,
          status TEXT DEFAULT 'pending',
          amount NUMERIC(10, 2) NOT NULL,
          admin_note TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          reviewed_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS support_tickets (
          id TEXT PRIMARY KEY,
          ticket_number TEXT UNIQUE NOT NULL,
          user_telegram_id TEXT NOT NULL,
          user_name TEXT,
          subject TEXT,
          messages JSONB DEFAULT '[]'::jsonb,
          status TEXT DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS processed_updates (
          update_id BIGINT PRIMARY KEY,
          processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS analytics_events (
          id SERIAL PRIMARY KEY,
          event_type TEXT NOT NULL,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS force_channels (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          channel_name TEXT NOT NULL,
          invite_link TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS referrals (
          id TEXT PRIMARY KEY,
          referrer_id TEXT NOT NULL,
          referred_id TEXT NOT NULL,
          referred_name TEXT,
          type TEXT NOT NULL,
          amount NUMERIC(10, 2) NOT NULL,
          order_id TEXT,
          order_number TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS withdrawals (
          id TEXT PRIMARY KEY,
          user_telegram_id TEXT NOT NULL,
          user_name TEXT,
          amount NUMERIC(10, 2) NOT NULL,
          payment_details TEXT,
          status TEXT DEFAULT 'pending',
          admin_reason TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          reviewed_at TIMESTAMP
        );
      `);
    } finally {
      client.release();
    }
  }

  async seedDefaults() {
    if (config.initialSuperAdminId) {
      await this.ensureSuperAdmin(config.initialSuperAdminId);
    }

    const defaultSettings = {
      upi_id: 'business@upi',
      receiver_name: 'Master Business Automation',
      payment_instructions: '1. Scan the QR or pay to UPI ID\n2. Note your 12-digit UTR/Txn ID\n3. Upload screenshot/UTR below',
      qr_image_file_id: '',
      currency: 'INR',
      about_text: 'Welcome to Master Business Bot! Your all-in-one platform for high quality digital/physical products, professional business services, verified earning opportunities, and dedicated 24/7 support.'
    };

    const currentSettings = await this.getSettings();
    if (!currentSettings || Object.keys(currentSettings).length === 0) {
      await this.saveSettings(defaultSettings);
    }

    if (!currentSettings.has_seeded_catalog) {
      const products = await this.getProducts();
      if (products.length === 0) {
        await this.saveProduct({
          id: 'prod_' + Date.now(),
          name: 'VIP Business E-Book & Toolkit',
          description: 'Complete step-by-step business automation blueprint + downloadable resource pack.',
          price: 499,
          type: 'digital',
          stock: 0,
          is_unlimited: true,
          delivery_info: 'Instant download link sent automatically upon payment confirmation.',
          image_url: '',
          is_active: true
        });
      }

      const services = await this.getServices();
      if (services.length === 0) {
        await this.saveService({
          id: 'srv_' + Date.now(),
          name: 'Custom Telegram Bot Setup & Deployment',
          description: 'Full bot architecture, webhook setup, and custom feature integration done for you.',
          price: 2499,
          delivery_time: '24-48 Hours',
          requirements: 'Please provide your BotFather token, business name, and catalog details.',
          image_url: '',
          is_active: true
        });
      }

      currentSettings.has_seeded_catalog = true;
      await this.saveSettings(currentSettings);
    }

    const opps = await this.getEarningOpportunities();
    if (opps.length === 0) {
      await this.saveEarningOpportunity({
        id: 'earn_' + Date.now(),
        name: 'Affiliate Partner Program',
        description: 'Earn generous 25% commissions for every customer who buys our products or services.',
        reward_info: 'Earn 25% lifetime commission on referred orders.',
        how_to_earn: '1. Share your custom referral link.\n2. When your referral completes a purchase, your wallet credits automatically.\n3. Request payout anytime to UPI or Crypto.',
        external_url: 'https://telegram.org',
        referral_info: 'Contact @Support to receive your unique tracked partner banner and affiliate ID.',
        terms: 'Fair usage only. Self-referrals are strictly prohibited and will result in account forfeiture.',
        image_url: '',
        is_active: true
      });
    }

    const coupons = await this.getCoupons();
    if (coupons.length === 0) {
      await this.saveCoupon({
        code: 'WELCOME20',
        description: '20% Welcome Discount on your first order',
        discount_type: 'percent',
        discount_value: 20,
        expiry_date: null,
        usage_limit: 1000,
        times_used: 0,
        applicable_to: 'all',
        is_active: true
      });
    }
  }

  // --- Super Admin & Admins ---

  async ensureSuperAdmin(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.ensureSuperAdmin(telegramId);
    const admin = await this.getAdmin(telegramId);
    if (!admin) {
      await this.saveAdmin({
        telegram_id: String(telegramId),
        username: 'SuperAdmin',
        role: 'super_admin',
        permissions: ['*'],
        added_at: new Date().toISOString(),
        added_by: 'system'
      });
      console.log(`👑 Super Admin registered: ${telegramId}`);
    } else if (admin.role !== 'super_admin') {
      admin.role = 'super_admin';
      admin.permissions = ['*'];
      await this.saveAdmin(admin);
    }
  }

  async getAdmin(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.getAdmin(telegramId);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM admins WHERE telegram_id = $1', [tid]);
      return res.rows[0] || null;
    }
    return this.data.admins.find(a => String(a.telegram_id) === tid) || null;
  }

  async getAdmins() {
    if (this.type === 'firestore') return await this.firestoreStore.getAdmins();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM admins ORDER BY added_at ASC');
      return res.rows;
    }
    return this.data.admins || [];
  }

  async saveAdmin(admin) {
    if (this.type === 'firestore') return await this.firestoreStore.saveAdmin(admin);
    const tid = String(admin.telegram_id);
    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO admins (telegram_id, username, role, permissions, added_at, added_by)
        VALUES ($1, $2, $3, $4, NOW(), $5)
        ON CONFLICT (telegram_id)
        DO UPDATE SET username = $2, role = $3, permissions = $4
      `, [tid, admin.username, admin.role || 'admin', JSON.stringify(admin.permissions || []), admin.added_by]);
      return admin;
    }
    const idx = this.data.admins.findIndex(a => String(a.telegram_id) === tid);
    if (idx >= 0) {
      this.data.admins[idx] = { ...this.data.admins[idx], ...admin };
    } else {
      this.data.admins.push(admin);
    }
    this.saveFileStore();
    return admin;
  }

  async deleteAdmin(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteAdmin(telegramId);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM admins WHERE telegram_id = $1', [tid]);
      return;
    }
    this.data.admins = this.data.admins.filter(a => String(a.telegram_id) !== tid);
    this.saveFileStore();
  }

  async removeAdmin(telegramId) {
    return await this.deleteAdmin(telegramId);
  }

  // --- Users ---

  async upsertUser(user) {
    if (this.type === 'firestore') return await this.firestoreStore.upsertUser(user);
    const tid = String(user.telegram_id);
    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        INSERT INTO users (telegram_id, username, first_name, withdrawable_balance, referral_count, is_blocked, last_active_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (telegram_id)
        DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
                      withdrawable_balance = COALESCE($4, users.withdrawable_balance),
                      referral_count = COALESCE($5, users.referral_count),
                      last_active_at = NOW()
        RETURNING *;
      `, [tid, user.username, user.first_name, user.withdrawable_balance, user.referral_count, user.is_blocked || false]);
      return res.rows[0];
    }
    const idx = this.data.users.findIndex(u => String(u.telegram_id) === tid);
    const now = new Date().toISOString();
    if (idx >= 0) {
      this.data.users[idx] = {
        ...this.data.users[idx],
        username: user.username !== undefined ? user.username : this.data.users[idx].username,
        first_name: user.first_name || this.data.users[idx].first_name,
        withdrawable_balance: user.withdrawable_balance !== undefined ? user.withdrawable_balance : this.data.users[idx].withdrawable_balance,
        referral_count: user.referral_count !== undefined ? user.referral_count : this.data.users[idx].referral_count,
        last_active_at: now
      };
      this.saveFileStore();
      return this.data.users[idx];
    }
    const newUser = {
      id: this.data.users.length + 1,
      telegram_id: tid,
      username: user.username || '',
      first_name: user.first_name || 'User',
      withdrawable_balance: Number(user.withdrawable_balance || 0),
      referral_count: Number(user.referral_count || 0),
      is_blocked: false,
      joined_at: now,
      last_active_at: now
    };
    this.data.users.push(newUser);
    this.saveFileStore();
    return newUser;
  }

  async getUser(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.getUser(telegramId);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      return res.rows[0] || null;
    }
    return this.data.users.find(u => String(u.telegram_id) === tid) || null;
  }

  async getUsers() {
    if (this.type === 'firestore') return await this.firestoreStore.getUsers();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM users ORDER BY joined_at DESC');
      return res.rows;
    }
    return this.data.users || [];
  }

  async setUserBlocked(telegramId, isBlocked) {
    if (this.type === 'firestore') return await this.firestoreStore.setUserBlocked(telegramId, isBlocked);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      await this.pool.query('UPDATE users SET is_blocked = $1 WHERE telegram_id = $2', [Boolean(isBlocked), tid]);
      return;
    }
    const user = this.data.users.find(u => String(u.telegram_id) === tid);
    if (user) {
      user.is_blocked = Boolean(isBlocked);
      this.saveFileStore();
    }
  }

  // --- Products ---

  async getProducts(activeOnly = false) {
    if (this.type === 'firestore') return await this.firestoreStore.getProducts(activeOnly);
    if (this.type === 'postgres') {
      const query = activeOnly ? 'SELECT * FROM products WHERE is_active = TRUE ORDER BY created_at DESC' : 'SELECT * FROM products ORDER BY created_at DESC';
      const res = await this.pool.query(query);
      return res.rows;
    }
    const list = this.data.products || [];
    return list.filter(p => !activeOnly || p.is_active);
  }

  async getProduct(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getProduct(id);
    const pid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM products WHERE id = $1', [pid]);
      return res.rows[0] || null;
    }
    return this.data.products.find(p => String(p.id) === pid) || null;
  }

  async saveProduct(product) {
    if (this.type === 'firestore') return await this.firestoreStore.saveProduct(product);
    if (!product.id) product.id = 'prod_' + Date.now();
    product.is_active = product.is_active ?? true;
    product.stock = product.stock !== undefined ? Number(product.stock) : 0;
    product.price = Number(product.price);
    product.created_at = product.created_at || new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO products (id, name, description, price, type, stock, is_unlimited, delivery_info, image_url, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id)
        DO UPDATE SET name = $2, description = $3, price = $4, type = $5, stock = $6, is_unlimited = $7, delivery_info = $8, image_url = $9, is_active = $10
      `, [product.id, product.name, product.description, product.price, product.type || 'physical', product.stock, product.is_unlimited || false, product.delivery_info, product.image_url, product.is_active, product.created_at]);
      return product;
    }
    const idx = this.data.products.findIndex(p => String(p.id) === String(product.id));
    if (idx >= 0) {
      this.data.products[idx] = { ...this.data.products[idx], ...product };
    } else {
      this.data.products.push(product);
    }
    this.saveFileStore();
    return product;
  }

  async deleteProduct(id) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteProduct(id);
    const pid = String(id);
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM products WHERE id = $1', [pid]);
      return;
    }
    this.data.products = this.data.products.filter(p => String(p.id) !== pid);
    this.saveFileStore();
  }

  // --- Services ---

  async getServices(activeOnly = false) {
    if (this.type === 'firestore') return await this.firestoreStore.getServices(activeOnly);
    if (this.type === 'postgres') {
      const query = activeOnly ? 'SELECT * FROM services WHERE is_active = TRUE ORDER BY created_at DESC' : 'SELECT * FROM services ORDER BY created_at DESC';
      const res = await this.pool.query(query);
      return res.rows;
    }
    const list = this.data.services || [];
    return list.filter(s => !activeOnly || s.is_active);
  }

  async getService(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getService(id);
    const sid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM services WHERE id = $1', [sid]);
      return res.rows[0] || null;
    }
    return this.data.services.find(s => String(s.id) === sid) || null;
  }

  async saveService(service) {
    if (this.type === 'firestore') return await this.firestoreStore.saveService(service);
    if (!service.id) service.id = 'srv_' + Date.now();
    service.is_active = service.is_active ?? true;
    service.price = Number(service.price);
    service.created_at = service.created_at || new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO services (id, name, description, price, delivery_time, requirements, image_url, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id)
        DO UPDATE SET name = $2, description = $3, price = $4, delivery_time = $5, requirements = $6, image_url = $7, is_active = $8
      `, [service.id, service.name, service.description, service.price, service.delivery_time, service.requirements, service.image_url, service.is_active, service.created_at]);
      return service;
    }
    const idx = this.data.services.findIndex(s => String(s.id) === String(service.id));
    if (idx >= 0) {
      this.data.services[idx] = { ...this.data.services[idx], ...service };
    } else {
      this.data.services.push(service);
    }
    this.saveFileStore();
    return service;
  }

  async deleteService(id) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteService(id);
    const sid = String(id);
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM services WHERE id = $1', [sid]);
      return;
    }
    this.data.services = this.data.services.filter(s => String(s.id) !== sid);
    this.saveFileStore();
  }

  // --- Earning Opportunities ---

  async getEarningOpportunities(activeOnly = false) {
    if (this.type === 'firestore') return await this.firestoreStore.getEarningOpportunities(activeOnly);
    if (this.type === 'postgres') {
      const query = activeOnly ? 'SELECT * FROM earning_opportunities WHERE is_active = TRUE ORDER BY created_at DESC' : 'SELECT * FROM earning_opportunities ORDER BY created_at DESC';
      const res = await this.pool.query(query);
      return res.rows;
    }
    const list = this.data.earning_opportunities || [];
    return list.filter(o => !activeOnly || o.is_active);
  }

  async getEarningOpportunity(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getEarningOpportunity(id);
    const oid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM earning_opportunities WHERE id = $1', [oid]);
      return res.rows[0] || null;
    }
    return this.data.earning_opportunities.find(o => String(o.id) === oid) || null;
  }

  async saveEarningOpportunity(opportunity) {
    if (this.type === 'firestore') return await this.firestoreStore.saveEarningOpportunity(opportunity);
    if (!opportunity.id) opportunity.id = 'earn_' + Date.now();
    opportunity.is_active = opportunity.is_active ?? true;
    opportunity.created_at = opportunity.created_at || new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO earning_opportunities (id, name, description, reward_info, how_to_earn, external_url, referral_info, terms, image_url, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id)
        DO UPDATE SET name = $2, description = $3, reward_info = $4, how_to_earn = $5, external_url = $6, referral_info = $7, terms = $8, image_url = $9, is_active = $10
      `, [opportunity.id, opportunity.name, opportunity.description, opportunity.reward_info, opportunity.how_to_earn, opportunity.external_url, opportunity.referral_info, opportunity.terms, opportunity.image_url, opportunity.is_active, opportunity.created_at]);
      return opportunity;
    }
    const idx = this.data.earning_opportunities.findIndex(o => String(o.id) === String(opportunity.id));
    if (idx >= 0) {
      this.data.earning_opportunities[idx] = { ...this.data.earning_opportunities[idx], ...opportunity };
    } else {
      this.data.earning_opportunities.push(opportunity);
    }
    this.saveFileStore();
    return opportunity;
  }

  async deleteEarningOpportunity(id) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteEarningOpportunity(id);
    const oid = String(id);
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM earning_opportunities WHERE id = $1', [oid]);
      return;
    }
    this.data.earning_opportunities = this.data.earning_opportunities.filter(o => String(o.id) !== oid);
    this.saveFileStore();
  }

  // --- Coupons ---

  async getCoupons(activeOnly = false) {
    if (this.type === 'firestore') return await this.firestoreStore.getCoupons(activeOnly);
    if (this.type === 'postgres') {
      const query = activeOnly ? 'SELECT * FROM coupons WHERE is_active = TRUE ORDER BY created_at DESC' : 'SELECT * FROM coupons ORDER BY created_at DESC';
      const res = await this.pool.query(query);
      return res.rows;
    }
    const list = this.data.coupons || [];
    return list.filter(c => !activeOnly || c.is_active);
  }

  async getCoupon(code) {
    if (this.type === 'firestore') return await this.firestoreStore.getCoupon(code);
    const cCode = String(code).toUpperCase().trim();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM coupons WHERE code = $1', [cCode]);
      return res.rows[0] || null;
    }
    return this.data.coupons.find(c => String(c.code).toUpperCase() === cCode) || null;
  }

  async saveCoupon(coupon) {
    if (this.type === 'firestore') return await this.firestoreStore.saveCoupon(coupon);
    const cCode = String(coupon.code).toUpperCase().trim();
    coupon.code = cCode;
    coupon.is_active = coupon.is_active ?? true;
    coupon.discount_value = Number(coupon.discount_value);
    coupon.created_at = coupon.created_at || new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO coupons (code, description, discount_type, discount_value, expiry_date, usage_limit, times_used, applicable_to, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (code)
        DO UPDATE SET description = $2, discount_type = $3, discount_value = $4, expiry_date = $5, usage_limit = $6, times_used = $7, applicable_to = $8, is_active = $9
      `, [coupon.code, coupon.description, coupon.discount_type || 'percent', coupon.discount_value, coupon.expiry_date, coupon.usage_limit || 0, coupon.times_used || 0, coupon.applicable_to || 'all', coupon.is_active, coupon.created_at]);
      return coupon;
    }
    const idx = this.data.coupons.findIndex(c => String(c.code).toUpperCase() === cCode);
    if (idx >= 0) {
      this.data.coupons[idx] = { ...this.data.coupons[idx], ...coupon };
    } else {
      this.data.coupons.push(coupon);
    }
    this.saveFileStore();
    return coupon;
  }

  async deleteCoupon(code) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteCoupon(code);
    const cCode = String(code).toUpperCase().trim();
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM coupons WHERE code = $1', [cCode]);
      return;
    }
    this.data.coupons = this.data.coupons.filter(c => String(c.code).toUpperCase() !== cCode);
    this.saveFileStore();
  }

  // --- Orders ---

  async createOrder(order) {
    if (this.type === 'firestore') return await this.firestoreStore.createOrder(order);
    if (!order.id) order.id = 'ord_' + Date.now();
    if (!order.order_number) order.order_number = 'MB-' + Math.floor(10000000 + Math.random() * 90000000);
    order.status = order.status || 'pending';
    order.created_at = order.created_at || new Date().toISOString();
    order.updated_at = new Date().toISOString();
    order.final_amount = Number(order.final_amount);
    order.original_amount = Number(order.original_amount);
    order.discount = Number(order.discount || 0);

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO orders (id, order_number, user_telegram_id, user_name, item_type, item_id, item_name, original_amount, discount, final_amount, status, requirements, delivery_info, payment_proof_file_id, utr_number, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [order.id, order.order_number, order.user_telegram_id, order.user_name, order.item_type, order.item_id, order.item_name, order.original_amount, order.discount, order.final_amount, order.status, order.requirements, order.delivery_info, order.payment_proof_file_id, order.utr_number, order.created_at, order.updated_at]);
      return order;
    }
    this.data.orders.push(order);
    this.saveFileStore();
    return order;
  }

  async getOrder(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getOrder(id);
    const oid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM orders WHERE id = $1', [oid]);
      return res.rows[0] || null;
    }
    return this.data.orders.find(o => String(o.id) === oid) || null;
  }

  async getOrderByNumber(orderNumber) {
    if (this.type === 'firestore') return await this.firestoreStore.getOrderByNumber(orderNumber);
    const onum = String(orderNumber).trim();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM orders WHERE order_number = $1', [onum]);
      return res.rows[0] || null;
    }
    return this.data.orders.find(o => String(o.order_number) === onum) || null;
  }

  async getUserOrders(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.getUserOrders(telegramId);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM orders WHERE user_telegram_id = $1 ORDER BY created_at DESC', [tid]);
      return res.rows;
    }
    return this.data.orders.filter(o => String(o.user_telegram_id) === tid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getOrders(limitCount = 50, status = null) {
    if (this.type === 'firestore') return await this.firestoreStore.getOrders(limitCount, status);
    if (this.type === 'postgres') {
      const query = status ? 'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1';
      const params = status ? [status, limitCount] : [limitCount];
      const res = await this.pool.query(query, params);
      return res.rows;
    }
    let list = this.data.orders || [];
    if (status) list = list.filter(o => o.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limitCount);
  }

  async updateOrderStatus(id, status, deliveryInfo = '') {
    if (this.type === 'firestore') return await this.firestoreStore.updateOrderStatus(id, status, deliveryInfo);
    const oid = String(id);
    if (this.type === 'postgres') {
      const query = deliveryInfo ? 'UPDATE orders SET status = $1, delivery_info = $2, updated_at = NOW() WHERE id = $3 RETURNING *' : 'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
      const params = deliveryInfo ? [status, deliveryInfo, oid] : [status, oid];
      const res = await this.pool.query(query, params);
      return res.rows[0] || null;
    }
    const order = this.data.orders.find(o => String(o.id) === oid);
    if (order) {
      order.status = status;
      if (deliveryInfo) order.delivery_info = deliveryInfo;
      order.updated_at = new Date().toISOString();
      this.saveFileStore();
      return order;
    }
    return null;
  }

  async updateOrderPaymentProof(id, proofFileId, utrNumber = '') {
    if (this.type === 'firestore') return await this.firestoreStore.updateOrderPaymentProof(id, proofFileId, utrNumber);
    const oid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        UPDATE orders SET payment_proof_file_id = $1, utr_number = $2, updated_at = NOW() WHERE id = $3 RETURNING *
      `, [proofFileId, utrNumber, oid]);
      return res.rows[0] || null;
    }
    const order = this.data.orders.find(o => String(o.id) === oid);
    if (order) {
      order.payment_proof_file_id = proofFileId;
      order.utr_number = utrNumber;
      order.updated_at = new Date().toISOString();
      this.saveFileStore();
      return order;
    }
    return null;
  }

  // --- Payments ---

  async createPayment(payment) {
    if (this.type === 'firestore') return await this.firestoreStore.createPayment(payment);
    if (!payment.id) payment.id = 'pay_' + Date.now();
    payment.status = payment.status || 'pending';
    payment.created_at = payment.created_at || new Date().toISOString();
    payment.amount = Number(payment.amount);

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO payments (id, order_id, user_telegram_id, transaction_id, proof_file_id, status, amount, admin_note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [payment.id, payment.order_id, payment.user_telegram_id, payment.transaction_id, payment.proof_file_id, payment.status, payment.amount, payment.admin_note, payment.created_at]);
      return payment;
    }
    this.data.payments.push(payment);
    this.saveFileStore();
    return payment;
  }

  async getPayment(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getPayment(id);
    const pid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM payments WHERE id = $1', [pid]);
      return res.rows[0] || null;
    }
    return this.data.payments.find(p => String(p.id) === pid) || null;
  }

  async getPaymentByOrder(orderId) {
    if (this.type === 'firestore') return await this.firestoreStore.getPaymentByOrder(orderId);
    const oid = String(orderId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM payments WHERE order_id = $1', [oid]);
      return res.rows[0] || null;
    }
    return this.data.payments.find(p => String(p.order_id) === oid) || null;
  }

  async getPayments(status = null) {
    if (this.type === 'firestore') return await this.firestoreStore.getPayments(status);
    if (this.type === 'postgres') {
      const query = status ? 'SELECT * FROM payments WHERE status = $1 ORDER BY created_at DESC' : 'SELECT * FROM payments ORDER BY created_at DESC';
      const res = await this.pool.query(query, status ? [status] : []);
      return res.rows;
    }
    let list = this.data.payments || [];
    if (status) list = list.filter(p => p.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async updatePaymentStatus(id, status, adminNote = '') {
    if (this.type === 'firestore') return await this.firestoreStore.updatePaymentStatus(id, status, adminNote);
    const pid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        UPDATE payments SET status = $1, admin_note = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *
      `, [status, adminNote, pid]);
      return res.rows[0] || null;
    }
    const payment = this.data.payments.find(p => String(p.id) === pid);
    if (payment) {
      payment.status = status;
      payment.admin_note = adminNote;
      payment.reviewed_at = new Date().toISOString();
      this.saveFileStore();
      return payment;
    }
    return null;
  }

  // --- Support Tickets ---

  async createSupportTicket(ticket) {
    if (this.type === 'firestore') return await this.firestoreStore.createSupportTicket(ticket);
    if (!ticket.id) ticket.id = 'tkt_' + Date.now();
    if (!ticket.ticket_number) ticket.ticket_number = 'TKT-' + Math.floor(10000 + Math.random() * 90000);
    ticket.status = ticket.status || 'open';
    ticket.messages = ticket.messages || [];
    ticket.created_at = ticket.created_at || new Date().toISOString();
    ticket.updated_at = new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO support_tickets (id, ticket_number, user_telegram_id, user_name, subject, messages, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [ticket.id, ticket.ticket_number, ticket.user_telegram_id, ticket.user_name, ticket.subject, JSON.stringify(ticket.messages), ticket.status, ticket.created_at, ticket.updated_at]);
      return ticket;
    }
    this.data.support_tickets.push(ticket);
    this.saveFileStore();
    return ticket;
  }

  async getSupportTicket(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getSupportTicket(id);
    const tid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM support_tickets WHERE id = $1', [tid]);
      return res.rows[0] || null;
    }
    return this.data.support_tickets.find(t => String(t.id) === tid) || null;
  }

  async getTicket(id) {
    return await this.getSupportTicket(id);
  }

  async getSupportTicketByNumber(ticketNumber) {
    if (this.type === 'firestore') return await this.firestoreStore.getSupportTicketByNumber(ticketNumber);
    const tnum = String(ticketNumber).trim();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM support_tickets WHERE ticket_number = $1', [tnum]);
      return res.rows[0] || null;
    }
    return this.data.support_tickets.find(t => String(t.ticket_number) === tnum) || null;
  }

  async getUserSupportTickets(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.getUserSupportTickets(telegramId);
    const tid = String(telegramId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM support_tickets WHERE user_telegram_id = $1 ORDER BY created_at DESC', [tid]);
      return res.rows;
    }
    return this.data.support_tickets.filter(t => String(t.user_telegram_id) === tid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getSupportTickets(status = null) {
    if (this.type === 'firestore') return await this.firestoreStore.getSupportTickets(status);
    if (this.type === 'postgres') {
      const query = status ? 'SELECT * FROM support_tickets WHERE status = $1 ORDER BY created_at DESC' : 'SELECT * FROM support_tickets ORDER BY created_at DESC';
      const res = await this.pool.query(query, status ? [status] : []);
      return res.rows;
    }
    let list = this.data.support_tickets || [];
    if (status) list = list.filter(t => t.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async addTicketMessage(ticketId, senderOrMessage, maybeText) {
    if (this.type === 'firestore') return await this.firestoreStore.addTicketMessage(ticketId, senderOrMessage, maybeText);
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

    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        UPDATE support_tickets SET messages = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *
      `, [JSON.stringify(msgs), newStatus, tid]);
      return res.rows[0] || null;
    }
    ticket.messages = msgs;
    ticket.status = newStatus;
    ticket.updated_at = new Date().toISOString();
    this.saveFileStore();
    return ticket;
  }

  async updateTicketStatus(ticketId, status) {
    if (this.type === 'firestore') return await this.firestoreStore.updateTicketStatus(ticketId, status);
    const tid = String(ticketId);
    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *
      `, [status, tid]);
      return res.rows[0] || null;
    }
    const ticket = this.data.support_tickets.find(t => String(t.id) === tid);
    if (ticket) {
      ticket.status = status;
      ticket.updated_at = new Date().toISOString();
      this.saveFileStore();
      return ticket;
    }
    return null;
  }

  // --- Settings ---

  async getSettings() {
    if (this.type === 'firestore') return await this.firestoreStore.getSettings();
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT value FROM settings WHERE key = $1', ['global_config']);
      return res.rows[0] ? res.rows[0].value : {};
    }
    return this.data.settings || {};
  }

  async saveSettings(settings) {
    if (this.type === 'firestore') return await this.firestoreStore.saveSettings(settings);
    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO settings (key, value)
        VALUES ('global_config', $1)
        ON CONFLICT (key)
        DO UPDATE SET value = $1
      `, [JSON.stringify(settings)]);
      return settings;
    }
    this.data.settings = { ...this.data.settings, ...settings };
    this.saveFileStore();
    return this.data.settings;
  }

  // --- Processed Updates (Deduplication) ---

  async isUpdateProcessed(updateId) {
    if (this.type === 'firestore') return await this.firestoreStore.isUpdateProcessed(updateId);
    const uid = Number(updateId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT 1 FROM processed_updates WHERE update_id = $1', [uid]);
      return Boolean(res.rows[0]);
    }
    return this.data.processed_updates.includes(uid);
  }

  async markUpdateProcessed(updateId) {
    if (this.type === 'firestore') return await this.firestoreStore.markUpdateProcessed(updateId);
    const uid = Number(updateId);
    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING
      `, [uid]);
      return;
    }
    if (!this.data.processed_updates.includes(uid)) {
      this.data.processed_updates.push(uid);
      if (this.data.processed_updates.length > 2000) {
        this.data.processed_updates.shift();
      }
      this.saveFileStore();
    }
  }

  // --- Analytics ---

  async trackEvent(eventType, metadata = {}) {
    if (this.type === 'firestore') return await this.firestoreStore.trackEvent(eventType, metadata);
    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO analytics_events (event_type, metadata, created_at)
        VALUES ($1, $2, NOW())
      `, [eventType, JSON.stringify(metadata)]);
      return;
    }
    this.data.analytics_events.push({
      id: this.data.analytics_events.length + 1,
      event_type: eventType,
      metadata,
      created_at: new Date().toISOString()
    });
    this.saveFileStore();
  }

  async getDashboardStats() {
    if (this.type === 'firestore') return await this.firestoreStore.getDashboardStats();
    const users = await this.getUsers();
    const orders = await this.getOrders(500);
    const payments = await this.getPayments();
    const products = await this.getProducts();
    const services = await this.getServices();

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

  async getAnalytics(days = 7) {
    if (this.type === 'firestore') return await this.firestoreStore.getAnalytics(days);
    if (this.type === 'postgres') {
      const res = await this.pool.query(`
        SELECT * FROM analytics_events
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        ORDER BY created_at DESC
      `, [days]);
      return res.rows;
    }
    return this.data.analytics_events || [];
  }

  // --- Force Channels ---

  async getForceChannels(activeOnly = false) {
    if (this.type === 'firestore') return await this.firestoreStore.getForceChannels(activeOnly);
    if (this.type === 'postgres') {
      const query = activeOnly ? 'SELECT * FROM force_channels WHERE is_active = TRUE ORDER BY created_at DESC' : 'SELECT * FROM force_channels ORDER BY created_at DESC';
      const res = await this.pool.query(query);
      return res.rows;
    }
    const list = this.data.force_channels || [];
    return list.filter(c => !activeOnly || c.is_active);
  }

  async getForceChannel(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getForceChannel(id);
    const cid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM force_channels WHERE id = $1', [cid]);
      return res.rows[0] || null;
    }
    return (this.data.force_channels || []).find(c => String(c.id) === cid) || null;
  }

  async saveForceChannel(channel) {
    if (this.type === 'firestore') return await this.firestoreStore.saveForceChannel(channel);
    if (!channel.id) channel.id = 'fc_' + Date.now();
    channel.is_active = channel.is_active ?? true;
    channel.created_at = channel.created_at || new Date().toISOString();

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO force_channels (id, channel_id, channel_name, invite_link, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id)
        DO UPDATE SET channel_id = $2, channel_name = $3, invite_link = $4, is_active = $5
      `, [channel.id, channel.channel_id, channel.channel_name, channel.invite_link, channel.is_active, channel.created_at]);
      return channel;
    }
    if (!this.data.force_channels) this.data.force_channels = [];
    const idx = this.data.force_channels.findIndex(c => String(c.id) === String(channel.id));
    if (idx >= 0) {
      this.data.force_channels[idx] = { ...this.data.force_channels[idx], ...channel };
    } else {
      this.data.force_channels.push(channel);
    }
    this.saveFileStore();
    return channel;
  }

  async deleteForceChannel(id) {
    if (this.type === 'firestore') return await this.firestoreStore.deleteForceChannel(id);
    const cid = String(id);
    if (this.type === 'postgres') {
      await this.pool.query('DELETE FROM force_channels WHERE id = $1', [cid]);
      return;
    }
    if (!this.data.force_channels) this.data.force_channels = [];
    this.data.force_channels = this.data.force_channels.filter(c => String(c.id) !== cid);
    this.saveFileStore();
  }

  // --- Referrals & Affiliate Earnings ---

  async recordReferralJoin(newUserId, referrerId, newUserName) {
    if (this.type === 'firestore') return await this.firestoreStore.recordReferralJoin(newUserId, referrerId, newUserName);
    const refId = String(referrerId);
    const newUid = String(newUserId);
    if (refId === newUid) return null;

    if (!this.data.referrals) this.data.referrals = [];
    const alreadyReferred = this.data.referrals.some(r => String(r.referred_id) === newUid && r.type === 'join');
    if (alreadyReferred) return null;

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

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO referrals (id, referrer_id, referred_id, referred_name, type, amount, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [referralDoc.id, refId, newUid, referralDoc.referred_name, referralDoc.type, reward]);
    } else {
      this.data.referrals.push(referralDoc);
      this.saveFileStore();
    }

    return {
      success: true,
      reward,
      newBalance,
      referrerId: refId
    };
  }

  async recordReferralCommission(referrerId, referredId, orderId, orderNumber, amount) {
    if (this.type === 'firestore') return await this.firestoreStore.recordReferralCommission(referrerId, referredId, orderId, orderNumber, amount);
    const refId = String(referrerId);
    const referrer = await this.getUser(refId);
    if (!referrer) return null;

    const commissionAmt = Number(amount);
    const newBalance = Number(referrer.withdrawable_balance || 0) + commissionAmt;

    await this.upsertUser({
      telegram_id: refId,
      withdrawable_balance: newBalance
    });

    const referralDoc = {
      id: 'ref_comm_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      referrer_id: refId,
      referred_id: String(referredId),
      referred_name: '',
      type: 'commission',
      amount: commissionAmt,
      order_id: String(orderId),
      order_number: String(orderNumber),
      created_at: new Date().toISOString()
    };

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO referrals (id, referrer_id, referred_id, referred_name, type, amount, order_id, order_number, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [referralDoc.id, refId, referralDoc.referred_id, referralDoc.referred_name, referralDoc.type, commissionAmt, referralDoc.order_id, referralDoc.order_number]);
    } else {
      if (!this.data.referrals) this.data.referrals = [];
      this.data.referrals.push(referralDoc);
      this.saveFileStore();
    }

    return {
      success: true,
      commissionAmt,
      newBalance,
      referrerId: refId
    };
  }

  async getUserReferrals(telegramId) {
    if (this.type === 'firestore') return await this.firestoreStore.getUserReferrals(telegramId);
    return await this.getReferrals(telegramId);
  }

  async getReferrals(referrerId) {
    if (this.type === 'firestore') return await this.firestoreStore.getReferrals(referrerId);
    const refId = String(referrerId);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC', [refId]);
      return res.rows;
    }
    const list = this.data.referrals || [];
    return list.filter(r => String(r.referrer_id) === refId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  // --- Withdrawals ---

  async createWithdrawal(telegramId, userName, amount, paymentDetails) {
    if (this.type === 'firestore') return await this.firestoreStore.createWithdrawal(telegramId, userName, amount, paymentDetails);
    const tid = String(telegramId);
    const user = await this.getUser(tid);
    const amt = Number(amount);
    if (!user || Number(user.withdrawable_balance || 0) < amt) {
      throw new Error('Insufficient withdrawable balance.');
    }

    const updatedWithdrawable = Number(user.withdrawable_balance || 0) - amt;
    await this.upsertUser({
      telegram_id: tid,
      withdrawable_balance: updatedWithdrawable
    });

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

    if (this.type === 'postgres') {
      await this.pool.query(`
        INSERT INTO withdrawals (id, user_telegram_id, user_name, amount, payment_details, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [withdrawal.id, tid, withdrawal.user_name, amt, paymentDetails, 'pending']);
    } else {
      if (!this.data.withdrawals) this.data.withdrawals = [];
      this.data.withdrawals.push(withdrawal);
      this.saveFileStore();
    }

    return withdrawal;
  }

  async getWithdrawals(status = null) {
    if (this.type === 'firestore') return await this.firestoreStore.getWithdrawals(status);
    if (this.type === 'postgres') {
      const query = status ? 'SELECT * FROM withdrawals WHERE status = $1 ORDER BY created_at DESC' : 'SELECT * FROM withdrawals ORDER BY created_at DESC';
      const res = await this.pool.query(query, status ? [status] : []);
      return res.rows;
    }
    let list = this.data.withdrawals || [];
    if (status) list = list.filter(w => w.status === status);
    return [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async getWithdrawal(id) {
    if (this.type === 'firestore') return await this.firestoreStore.getWithdrawal(id);
    const wid = String(id);
    if (this.type === 'postgres') {
      const res = await this.pool.query('SELECT * FROM withdrawals WHERE id = $1', [wid]);
      return res.rows[0] || null;
    }
    return (this.data.withdrawals || []).find(w => String(w.id) === wid) || null;
  }

  async updateWithdrawalStatus(id, status, reason = '') {
    if (this.type === 'firestore') return await this.firestoreStore.updateWithdrawalStatus(id, status, reason);
    const wid = String(id);
    const withdrawal = await this.getWithdrawal(wid);
    if (!withdrawal) return null;

    if (status === 'rejected' && withdrawal.status === 'pending') {
      const user = await this.getUser(withdrawal.user_telegram_id);
      if (user) {
        const refunded = Number(user.withdrawable_balance || 0) + Number(withdrawal.amount);
        await this.upsertUser({
          telegram_id: user.telegram_id,
          withdrawable_balance: refunded
        });
      }
    }

    if (this.type === 'postgres') {
      await this.pool.query(`
        UPDATE withdrawals SET status = $1, admin_reason = $2, reviewed_at = NOW() WHERE id = $3
      `, [status, reason, wid]);
    } else {
      withdrawal.status = status;
      withdrawal.admin_reason = reason;
      withdrawal.reviewed_at = new Date().toISOString();
      this.saveFileStore();
    }

    return withdrawal;
  }
}

export const db = new Database();
