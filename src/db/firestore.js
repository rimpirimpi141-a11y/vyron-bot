import fs from 'fs';
import path from 'path';
import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit as firestoreLimit
} from 'firebase/firestore';

export class FirestoreStore {
  constructor() {
    this.app = null;
    this.db = null;
    this.config = null;
    this.isInitialized = false;

    // In-memory cache to guarantee low Firestore read usage and free-tier safety
    this.cache = {
      products: null,
      services: null,
      earning_opportunities: null,
      coupons: null,
      settings: null,
      force_channels: null,
      admins: null
    };
    this.cacheTtlMs = 60000; // 60 seconds
    this.recentProcessedUpdates = new Set();
  }

  async init() {
    if (this.isInitialized) return;

    let rawConfig = null;
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else if (process.env.FIREBASE_CONFIG) {
      rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    }

    if (!rawConfig) {
      throw new Error('No Firebase configuration found (missing firebase-applet-config.json)');
    }

    this.config = rawConfig;
    this.app = initializeApp(this.config);
    this.db = initializeFirestore(this.app, {}, this.config.firestoreDatabaseId || '(default)');

    // Verify connectivity with a server ping
    try {
      const pingRef = doc(this.db, '_test_connection', 'ping');
      await setDoc(pingRef, {
        timestamp: Date.now(),
        status: 'connected',
        provider: 'firestore'
      });
      console.log('🔥 Cloud Firestore connection verified successfully.');
    } catch (err) {
      console.error('⚠️ Could not verify Firestore connection:', err.message);
      throw err;
    }

    this.isInitialized = true;
  }

  // --- Cache Helpers ---
  getCached(key) {
    const entry = this.cache[key];
    if (entry && (Date.now() - entry.timestamp < this.cacheTtlMs)) {
      return entry.data;
    }
    return null;
  }

  setCached(key, data) {
    this.cache[key] = {
      data,
      timestamp: Date.now()
    };
  }

  invalidateCache(key) {
    this.cache[key] = null;
  }

  // --- Migration from ./data/db.json ---
  async migrateFromFileStore(filePath) {
    if (!fs.existsSync(filePath)) return;

    try {
      // Check if migration flag is already set in Firestore
      const settingsRef = doc(this.db, 'settings', 'global_config');
      const settingsSnap = await getDoc(settingsRef);
      if (settingsSnap.exists() && settingsSnap.data()._migrated_from_file) {
        return; // Already migrated, don't overwrite
      }

      console.log('📦 Reading existing data from ./data/db.json to migrate to Cloud Firestore...');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);

      let migratedCount = 0;

      // Migrate Users
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          if (u.telegram_id) {
            await setDoc(doc(this.db, 'users', String(u.telegram_id)), {
              ...u,
              telegram_id: String(u.telegram_id),
              withdrawable_balance: Number(u.withdrawable_balance || 0),
              referral_count: Number(u.referral_count || 0)
            }, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Admins
      if (Array.isArray(data.admins)) {
        for (const a of data.admins) {
          if (a.telegram_id) {
            await setDoc(doc(this.db, 'admins', String(a.telegram_id)), {
              ...a,
              telegram_id: String(a.telegram_id)
            }, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Products
      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          if (p.id) {
            await setDoc(doc(this.db, 'products', String(p.id)), p, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Services
      if (Array.isArray(data.services)) {
        for (const s of data.services) {
          if (s.id) {
            await setDoc(doc(this.db, 'services', String(s.id)), s, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Earning Opportunities
      if (Array.isArray(data.earning_opportunities)) {
        for (const o of data.earning_opportunities) {
          if (o.id) {
            await setDoc(doc(this.db, 'earning_opportunities', String(o.id)), o, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Coupons
      if (Array.isArray(data.coupons)) {
        for (const c of data.coupons) {
          if (c.code) {
            await setDoc(doc(this.db, 'coupons', String(c.code)), c, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Orders
      if (Array.isArray(data.orders)) {
        for (const o of data.orders) {
          if (o.id) {
            await setDoc(doc(this.db, 'orders', String(o.id)), o, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Payments
      if (Array.isArray(data.payments)) {
        for (const p of data.payments) {
          if (p.id) {
            await setDoc(doc(this.db, 'payments', String(p.id)), p, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Support Tickets
      if (Array.isArray(data.support_tickets)) {
        for (const t of data.support_tickets) {
          if (t.id) {
            await setDoc(doc(this.db, 'support_tickets', String(t.id)), t, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Force Channels
      if (Array.isArray(data.force_channels)) {
        for (const fc of data.force_channels) {
          if (fc.id) {
            await setDoc(doc(this.db, 'force_channels', String(fc.id)), fc, { merge: true });
            migratedCount++;
          }
        }
      }

      // Migrate Settings
      const fileSettings = data.settings || {};
      fileSettings._migrated_from_file = true;
      fileSettings._migrated_at = new Date().toISOString();
      await setDoc(settingsRef, fileSettings, { merge: true });

      console.log(`✅ Successfully migrated ${migratedCount} records from ./data/db.json into Cloud Firestore!`);
    } catch (migErr) {
      console.warn('⚠️ Migration from file store encountered an issue:', migErr.message);
    }
  }

  // --- Super Admin & Admins ---

  async ensureSuperAdmin(telegramId) {
    const tid = String(telegramId);
    const admin = await this.getAdmin(tid);
    if (!admin) {
      await this.saveAdmin({
        telegram_id: tid,
        username: 'SuperAdmin',
        role: 'super_admin',
        permissions: ['*'],
        added_at: new Date().toISOString(),
        added_by: 'system'
      });
      console.log(`👑 Super Admin registered in Firestore: ${telegramId}`);
    } else if (admin.role !== 'super_admin') {
      admin.role = 'super_admin';
      admin.permissions = ['*'];
      await this.saveAdmin(admin);
    }
  }

  async getAdmin(telegramId) {
    const tid = String(telegramId);
    const cached = this.getCached('admins');
    if (cached) {
      const found = cached.find(a => String(a.telegram_id) === tid);
      if (found) return found;
    }

    try {
      const ref = doc(this.db, 'admins', tid);
      const snap = await getDoc(ref);
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error('Error fetching admin from Firestore:', e.message);
      return null;
    }
  }

  async getAdmins() {
    const cached = this.getCached('admins');
    if (cached) return cached;

    try {
      const snap = await getDocs(collection(this.db, 'admins'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      this.setCached('admins', list);
      return list;
    } catch (e) {
      console.error('Error fetching admins from Firestore:', e.message);
      return [];
    }
  }

  async saveAdmin(admin) {
    const tid = String(admin.telegram_id);
    const data = {
      ...admin,
      telegram_id: tid,
      updated_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'admins', tid), data, { merge: true });
    this.invalidateCache('admins');
    return data;
  }

  async deleteAdmin(telegramId) {
    const tid = String(telegramId);
    await deleteDoc(doc(this.db, 'admins', tid));
    this.invalidateCache('admins');
  }

  async removeAdmin(telegramId) {
    return await this.deleteAdmin(telegramId);
  }

  // --- Users ---

  async upsertUser(user) {
    const tid = String(user.telegram_id);
    const ref = doc(this.db, 'users', tid);
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

    await setDoc(ref, payload, { merge: true });
    return payload;
  }

  async getUser(telegramId) {
    const tid = String(telegramId);
    try {
      const snap = await getDoc(doc(this.db, 'users', tid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error('Error getting user from Firestore:', e.message);
      return null;
    }
  }

  async getUsers() {
    try {
      const snap = await getDocs(collection(this.db, 'users'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      return list;
    } catch (e) {
      console.error('Error getting users from Firestore:', e.message);
      return [];
    }
  }

  async setUserBlocked(telegramId, isBlocked) {
    const tid = String(telegramId);
    await setDoc(doc(this.db, 'users', tid), { is_blocked: Boolean(isBlocked) }, { merge: true });
  }

  // --- Products ---

  async getProducts(activeOnly = false) {
    const cached = this.getCached('products');
    if (cached) {
      return activeOnly ? cached.filter(p => p.is_active) : cached;
    }

    try {
      const snap = await getDocs(collection(this.db, 'products'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      this.setCached('products', list);
      return activeOnly ? list.filter(p => p.is_active) : list;
    } catch (e) {
      console.error('Error getting products from Firestore:', e.message);
      return [];
    }
  }

  async getProduct(id) {
    const pid = String(id);
    const cached = this.getCached('products');
    if (cached) {
      const found = cached.find(p => String(p.id) === pid);
      if (found) return found;
    }

    try {
      const snap = await getDoc(doc(this.db, 'products', pid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error('Error getting product from Firestore:', e.message);
      return null;
    }
  }

  async saveProduct(product) {
    if (!product.id) product.id = 'prod_' + Date.now();
    product.is_active = product.is_active ?? true;
    product.stock = product.stock !== undefined ? Number(product.stock) : 0;
    product.price = Number(product.price);
    product.created_at = product.created_at || new Date().toISOString();

    await setDoc(doc(this.db, 'products', String(product.id)), product, { merge: true });
    this.invalidateCache('products');
    return product;
  }

  async deleteProduct(id) {
    const pid = String(id);
    await deleteDoc(doc(this.db, 'products', pid));
    this.invalidateCache('products');
  }

  // --- Services ---

  async getServices(activeOnly = false) {
    const cached = this.getCached('services');
    if (cached) {
      return activeOnly ? cached.filter(s => s.is_active) : cached;
    }

    try {
      const snap = await getDocs(collection(this.db, 'services'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      this.setCached('services', list);
      return activeOnly ? list.filter(s => s.is_active) : list;
    } catch (e) {
      console.error('Error getting services from Firestore:', e.message);
      return [];
    }
  }

  async getService(id) {
    const sid = String(id);
    const cached = this.getCached('services');
    if (cached) {
      const found = cached.find(s => String(s.id) === sid);
      if (found) return found;
    }

    try {
      const snap = await getDoc(doc(this.db, 'services', sid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error('Error getting service from Firestore:', e.message);
      return null;
    }
  }

  async saveService(service) {
    if (!service.id) service.id = 'srv_' + Date.now();
    service.is_active = service.is_active ?? true;
    service.price = Number(service.price);
    service.created_at = service.created_at || new Date().toISOString();

    await setDoc(doc(this.db, 'services', String(service.id)), service, { merge: true });
    this.invalidateCache('services');
    return service;
  }

  async deleteService(id) {
    const sid = String(id);
    await deleteDoc(doc(this.db, 'services', sid));
    this.invalidateCache('services');
  }

  // --- Earning Opportunities ---

  async getEarningOpportunities(activeOnly = false) {
    const cached = this.getCached('earning_opportunities');
    if (cached) {
      return activeOnly ? cached.filter(o => o.is_active) : cached;
    }

    try {
      const snap = await getDocs(collection(this.db, 'earning_opportunities'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      this.setCached('earning_opportunities', list);
      return activeOnly ? list.filter(o => o.is_active) : list;
    } catch (e) {
      console.error('Error getting earning opportunities from Firestore:', e.message);
      return [];
    }
  }

  async getEarningOpportunity(id) {
    const oid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'earning_opportunities', oid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async saveEarningOpportunity(opportunity) {
    if (!opportunity.id) opportunity.id = 'earn_' + Date.now();
    opportunity.is_active = opportunity.is_active ?? true;
    opportunity.created_at = opportunity.created_at || new Date().toISOString();

    await setDoc(doc(this.db, 'earning_opportunities', String(opportunity.id)), opportunity, { merge: true });
    this.invalidateCache('earning_opportunities');
    return opportunity;
  }

  async deleteEarningOpportunity(id) {
    const oid = String(id);
    await deleteDoc(doc(this.db, 'earning_opportunities', oid));
    this.invalidateCache('earning_opportunities');
  }

  // --- Coupons ---

  async getCoupons(activeOnly = false) {
    const cached = this.getCached('coupons');
    if (cached) {
      return activeOnly ? cached.filter(c => c.is_active) : cached;
    }

    try {
      const snap = await getDocs(collection(this.db, 'coupons'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      this.setCached('coupons', list);
      return activeOnly ? list.filter(c => c.is_active) : list;
    } catch (e) {
      console.error('Error getting coupons from Firestore:', e.message);
      return [];
    }
  }

  async getCoupon(code) {
    const cCode = String(code).toUpperCase().trim();
    try {
      const snap = await getDoc(doc(this.db, 'coupons', cCode));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
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
    await setDoc(doc(this.db, 'coupons', cCode), payload, { merge: true });
    this.invalidateCache('coupons');
    return payload;
  }

  async deleteCoupon(code) {
    const cCode = String(code).toUpperCase().trim();
    await deleteDoc(doc(this.db, 'coupons', cCode));
    this.invalidateCache('coupons');
  }

  // --- Orders ---

  async createOrder(order) {
    if (!order.id) order.id = 'ord_' + Date.now();
    if (!order.order_number) order.order_number = 'MB-' + Math.floor(10000000 + Math.random() * 90000000);
    order.status = order.status || 'pending';
    order.created_at = order.created_at || new Date().toISOString();
    order.updated_at = new Date().toISOString();
    order.final_amount = Number(order.final_amount);
    order.original_amount = Number(order.original_amount);
    order.discount = Number(order.discount || 0);

    await setDoc(doc(this.db, 'orders', String(order.id)), order);
    return order;
  }

  async getOrder(id) {
    const oid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'orders', oid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async getOrderByNumber(orderNumber) {
    const onum = String(orderNumber).trim();
    try {
      const q = query(collection(this.db, 'orders'), where('order_number', '==', onum), firestoreLimit(1));
      const snap = await getDocs(q);
      let found = null;
      snap.forEach(d => { found = d.data(); });
      return found;
    } catch (e) {
      console.error('Error finding order by number:', e.message);
      return null;
    }
  }

  async getUserOrders(telegramId) {
    const tid = String(telegramId);
    try {
      const q = query(collection(this.db, 'orders'), where('user_telegram_id', '==', tid));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      console.error('Error getting user orders from Firestore:', e.message);
      return [];
    }
  }

  async getOrders(limitCount = 50, status = null) {
    try {
      let q = collection(this.db, 'orders');
      if (status) {
        q = query(q, where('status', '==', status));
      }
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list.slice(0, limitCount);
    } catch (e) {
      console.error('Error getting orders from Firestore:', e.message);
      return [];
    }
  }

  async updateOrderStatus(id, status, deliveryInfo = '') {
    const oid = String(id);
    const order = await this.getOrder(oid);
    if (!order) return null;

    const updates = {
      status,
      updated_at: new Date().toISOString()
    };
    if (deliveryInfo) updates.delivery_info = deliveryInfo;

    await setDoc(doc(this.db, 'orders', oid), updates, { merge: true });
    return { ...order, ...updates };
  }

  async updateOrderPaymentProof(id, proofFileId, utrNumber = '') {
    const oid = String(id);
    const updates = {
      payment_proof_file_id: proofFileId,
      utr_number: utrNumber,
      updated_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'orders', oid), updates, { merge: true });
    return await this.getOrder(oid);
  }

  // --- Payments ---

  async createPayment(payment) {
    if (!payment.id) payment.id = 'pay_' + Date.now();
    payment.status = payment.status || 'pending';
    payment.created_at = payment.created_at || new Date().toISOString();
    payment.amount = Number(payment.amount);

    await setDoc(doc(this.db, 'payments', String(payment.id)), payment);
    return payment;
  }

  async getPayment(id) {
    const pid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'payments', pid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async getPaymentByOrder(orderId) {
    const oid = String(orderId);
    try {
      const q = query(collection(this.db, 'payments'), where('order_id', '==', oid), firestoreLimit(1));
      const snap = await getDocs(q);
      let found = null;
      snap.forEach(d => { found = d.data(); });
      return found;
    } catch (e) {
      return null;
    }
  }

  async getPayments(status = null) {
    try {
      let q = collection(this.db, 'payments');
      if (status) {
        q = query(q, where('status', '==', status));
      }
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      return [];
    }
  }

  async updatePaymentStatus(id, status, adminNote = '') {
    const pid = String(id);
    const updates = {
      status,
      admin_note: adminNote,
      reviewed_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'payments', pid), updates, { merge: true });
    return await this.getPayment(pid);
  }

  // --- Support Tickets ---

  async createSupportTicket(ticket) {
    if (!ticket.id) ticket.id = 'tkt_' + Date.now();
    if (!ticket.ticket_number) ticket.ticket_number = 'TKT-' + Math.floor(10000 + Math.random() * 90000);
    ticket.status = ticket.status || 'open';
    ticket.messages = ticket.messages || [];
    ticket.created_at = ticket.created_at || new Date().toISOString();
    ticket.updated_at = new Date().toISOString();

    await setDoc(doc(this.db, 'support_tickets', String(ticket.id)), ticket);
    return ticket;
  }

  async getSupportTicket(id) {
    const tid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'support_tickets', tid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async getTicket(id) {
    return await this.getSupportTicket(id);
  }

  async getSupportTicketByNumber(ticketNumber) {
    const tnum = String(ticketNumber).trim();
    try {
      const q = query(collection(this.db, 'support_tickets'), where('ticket_number', '==', tnum), firestoreLimit(1));
      const snap = await getDocs(q);
      let found = null;
      snap.forEach(d => { found = d.data(); });
      return found;
    } catch (e) {
      return null;
    }
  }

  async getUserSupportTickets(telegramId) {
    const tid = String(telegramId);
    try {
      const q = query(collection(this.db, 'support_tickets'), where('user_telegram_id', '==', tid));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      return [];
    }
  }

  async getSupportTickets(status = null) {
    try {
      let q = collection(this.db, 'support_tickets');
      if (status) {
        q = query(q, where('status', '==', status));
      }
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      return [];
    }
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

    const updates = {
      messages: msgs,
      status: newStatus,
      updated_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'support_tickets', tid), updates, { merge: true });
    return { ...ticket, ...updates };
  }

  async updateTicketStatus(ticketId, status) {
    const tid = String(ticketId);
    const updates = {
      status,
      updated_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'support_tickets', tid), updates, { merge: true });
    return await this.getSupportTicket(tid);
  }

  // --- Settings ---

  async getSettings() {
    const cached = this.getCached('settings');
    if (cached) return cached;

    try {
      const snap = await getDoc(doc(this.db, 'settings', 'global_config'));
      if (snap.exists()) {
        const data = snap.data();
        this.setCached('settings', data);
        return data;
      }
      return {};
    } catch (e) {
      console.error('Error getting settings from Firestore:', e.message);
      return {};
    }
  }

  async saveSettings(settings) {
    const payload = {
      ...settings,
      updated_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'settings', 'global_config'), payload, { merge: true });
    this.setCached('settings', payload);
    return payload;
  }

  // --- Processed Updates (Deduplication) ---

  async isUpdateProcessed(updateId) {
    const uid = String(updateId);
    if (this.recentProcessedUpdates.has(uid)) return true;

    try {
      const snap = await getDoc(doc(this.db, 'processed_updates', uid));
      if (snap.exists()) {
        this.recentProcessedUpdates.add(uid);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async markUpdateProcessed(updateId) {
    const uid = String(updateId);
    this.recentProcessedUpdates.add(uid);
    // Keep in-memory cache bounded
    if (this.recentProcessedUpdates.size > 2000) {
      const first = this.recentProcessedUpdates.values().next().value;
      this.recentProcessedUpdates.delete(first);
    }

    try {
      await setDoc(doc(this.db, 'processed_updates', uid), {
        update_id: Number(updateId),
        processed_at: new Date().toISOString()
      });
    } catch (e) {
      // Non-critical if write fails
    }
  }

  // --- Analytics ---

  async trackEvent(eventType, metadata = {}) {
    try {
      const id = 'evt_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      await setDoc(doc(this.db, 'analytics_events', id), {
        id,
        event_type: eventType,
        metadata,
        created_at: new Date().toISOString()
      });
    } catch (e) {
      // Non-critical
    }
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

  async getAnalytics(days = 7) {
    try {
      const snap = await getDocs(collection(this.db, 'analytics_events'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      return list;
    } catch (e) {
      return [];
    }
  }

  // --- Force Channels ---

  async getForceChannels(activeOnly = false) {
    const cached = this.getCached('force_channels');
    if (cached) {
      return activeOnly ? cached.filter(c => c.is_active) : cached;
    }

    try {
      const snap = await getDocs(collection(this.db, 'force_channels'));
      const list = [];
      snap.forEach(d => list.push(d.data()));
      this.setCached('force_channels', list);
      return activeOnly ? list.filter(c => c.is_active) : list;
    } catch (e) {
      return [];
    }
  }

  async getForceChannel(id) {
    const cid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'force_channels', cid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async saveForceChannel(channel) {
    if (!channel.id) channel.id = 'fc_' + Date.now();
    channel.is_active = channel.is_active ?? true;
    channel.created_at = channel.created_at || new Date().toISOString();

    await setDoc(doc(this.db, 'force_channels', String(channel.id)), channel, { merge: true });
    this.invalidateCache('force_channels');
    return channel;
  }

  async deleteForceChannel(id) {
    const cid = String(id);
    await deleteDoc(doc(this.db, 'force_channels', cid));
    this.invalidateCache('force_channels');
  }

  // --- Referrals & Affiliate Earnings ---

  async recordReferralJoin(newUserId, referrerId, newUserName) {
    const refId = String(referrerId);
    const newUid = String(newUserId);
    if (refId === newUid) return null;

    // Check if new user was already referred
    try {
      const q = query(
        collection(this.db, 'referrals'),
        where('referred_id', '==', newUid),
        where('type', '==', 'join'),
        firestoreLimit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        return null; // Anti-cheat: already claimed join reward
      }
    } catch (e) {
      // Continue
    }

    const referrer = await this.getUser(refId);
    if (!referrer) return null;

    const reward = 2.0; // ₹2.00 join bonus
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
    await setDoc(doc(this.db, 'referrals', referralDoc.id), referralDoc);

    return {
      success: true,
      reward,
      newBalance,
      referrerId: refId
    };
  }

  async recordReferralCommission(referrerId, referredId, orderId, orderNumber, amount) {
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
    await setDoc(doc(this.db, 'referrals', referralDoc.id), referralDoc);

    return {
      success: true,
      commissionAmt,
      newBalance,
      referrerId: refId
    };
  }

  async getUserReferrals(telegramId) {
    const tid = String(telegramId);
    return await this.getReferrals(tid);
  }

  async getReferrals(referrerId) {
    const refId = String(referrerId);
    try {
      const q = query(collection(this.db, 'referrals'), where('referrer_id', '==', refId));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      return [];
    }
  }

  // --- Withdrawals ---

  async createWithdrawal(telegramId, userName, amount, paymentDetails) {
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

    await setDoc(doc(this.db, 'withdrawals', withdrawal.id), withdrawal);
    return withdrawal;
  }

  async getWithdrawals(status = null) {
    try {
      let q = collection(this.db, 'withdrawals');
      if (status) {
        q = query(q, where('status', '==', status));
      }
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return list;
    } catch (e) {
      return [];
    }
  }

  async getWithdrawal(id) {
    const wid = String(id);
    try {
      const snap = await getDoc(doc(this.db, 'withdrawals', wid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      return null;
    }
  }

  async updateWithdrawalStatus(id, status, reason = '') {
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

    const updates = {
      status,
      admin_reason: reason,
      reviewed_at: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'withdrawals', wid), updates, { merge: true });
    return { ...withdrawal, ...updates };
  }
}
