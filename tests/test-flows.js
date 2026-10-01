import assert from 'assert';
import { db } from '../src/db/index.js';
import { keyboards } from '../src/bot/keyboards.js';
import { stateManager } from '../src/bot/state.js';

async function runTests() {
  console.log('🧪 Starting 20-Point Business Bot Flow Verification...\n');

  // Flow 19 & 20: Database persistence & Initialization
  await db.init();
  console.log('✅ Flow 19: Database persistence initialized successfully (' + db.type + ')');

  // Test Super Admin Seed
  const testSuperAdminId = '999888777';
  await db.ensureSuperAdmin(testSuperAdminId);
  const superAdmin = await db.getAdmin(testSuperAdminId);
  assert(superAdmin !== null, 'Super Admin must exist');
  assert.strictEqual(superAdmin.role, 'super_admin');
  console.log('✅ Flow 7 & 8: Super Admin authentication verified');

  // Flow 1: /start
  const testUser = await db.upsertUser({
    telegram_id: '111222333',
    username: 'test_buyer',
    first_name: 'Alice'
  });
  assert(testUser !== null, 'User must be created');
  assert.strictEqual(testUser.telegram_id, '111222333');
  console.log('✅ Flow 1: /start user registration verified');

  // Flow 2: User Menu Keyboard
  const userKb = keyboards.mainMenu(false);
  assert(userKb.inline_keyboard.length > 0, 'Main menu keyboard must render');
  console.log('✅ Flow 2: User main menu rendered');

  // Flow 3: Product Browsing
  const products = await db.getProducts(true);
  assert(products.length > 0, 'Products catalog should have seeded items');
  console.log(`✅ Flow 3: Product browsing verified (${products.length} products loaded)`);

  // Flow 4: Service Browsing
  const services = await db.getServices(true);
  assert(services.length > 0, 'Services catalog should have seeded items');
  console.log(`✅ Flow 4: Service browsing verified (${services.length} services loaded)`);

  // Flow 5 & 6: Earning Opportunities Browsing & Separation
  const opps = await db.getEarningOpportunities(true);
  assert(opps.length > 0, 'Earning opportunities must be available');
  const sampleOpp = opps[0];
  const earnKb = keyboards.earningView(sampleOpp);
  
  // Verify earning opportunities NEVER have Buy Now or price buttons
  const earnButtonTexts = earnKb.inline_keyboard.flat().map(b => b.text.toLowerCase());
  const hasBuyOrPrice = earnButtonTexts.some(t => t.includes('buy') || t.includes('cart') || t.includes('price') || t.includes('stock'));
  assert.strictEqual(hasBuyOrPrice, false, 'Earning opportunities must NEVER have buy/price/cart buttons');
  console.log('✅ Flow 5 & 6: Earning opportunity browsing verified & strictly separated from products');

  // Flow 9: Add Product
  const newProduct = await db.saveProduct({
    name: 'Automation Mastery Video Course',
    description: '10 hours of high-definition video lessons',
    price: 999,
    type: 'digital',
    stock: 50,
    is_unlimited: false,
    delivery_info: 'Member portal access link sent immediately',
    is_active: true
  });
  assert(newProduct.id, 'New product must have an ID');
  console.log('✅ Flow 9: Add product verified');

  // Flow 10: Add Service
  const newService = await db.saveService({
    name: 'Website Speed Optimization',
    description: 'We boost your site Google PageSpeed score to 90+',
    price: 1999,
    delivery_time: '24 Hours',
    requirements: 'WordPress/Shopify admin credentials',
    is_active: true
  });
  assert(newService.id, 'New service must have an ID');
  console.log('✅ Flow 10: Add service verified');

  // Flow 11: Add Earning Opportunity
  const newOpp = await db.saveEarningOpportunity({
    name: 'Brand Ambassador Bounty',
    description: 'Promote our tools on Twitter/X or YouTube',
    reward_info: 'Earn up to ₹5000 per video mention',
    how_to_earn: 'Submit your published link to admin',
    external_url: 'https://example.com/bounty',
    referral_info: 'Use custom hashtag #MasterBusiness',
    terms: 'Minimum 500 impressions required',
    is_active: true
  });
  assert(newOpp.id, 'New opportunity must have an ID');
  console.log('✅ Flow 11: Add earning opportunity verified');

  // Flow 12: Order Creation
  const order = await db.createOrder({
    user_telegram_id: testUser.telegram_id,
    user_name: testUser.first_name,
    item_type: 'product',
    item_id: newProduct.id,
    item_name: newProduct.name,
    original_amount: newProduct.price,
    discount: 0,
    final_amount: newProduct.price,
    status: 'pending'
  });
  assert(order.order_number.startsWith('MB-'), 'Order number format verified');
  console.log(`✅ Flow 12: Order creation verified (${order.order_number})`);

  // Flow 13: Payment Proof Flow
  const payment = await db.createPayment({
    order_id: order.id,
    user_telegram_id: testUser.telegram_id,
    transaction_id: 'UTR998877665544',
    proof_file_id: 'test_file_id_receipt',
    status: 'pending',
    amount: order.final_amount
  });
  assert.strictEqual(payment.status, 'pending');
  console.log('✅ Flow 13: Payment proof flow verified');

  // Flow 14: Admin Order Management (Approve Payment & Update Status)
  await db.updatePaymentStatus(payment.id, 'approved', 'Verified in bank account');
  await db.updateOrderStatus(order.id, 'completed');
  const updatedOrder = await db.getOrder(order.id);
  assert.strictEqual(updatedOrder.status, 'completed');
  console.log('✅ Flow 14: Admin order management & status transitions verified');

  // Flow 15: User Profile
  const userOrders = await db.getUserOrders(testUser.telegram_id);
  assert(userOrders.length >= 1);
  assert.strictEqual(userOrders[0].status, 'completed');
  console.log('✅ Flow 15: User profile & order history tracking verified');

  // Flow 16: Support Ticket
  const ticket = await db.createSupportTicket({
    user_telegram_id: testUser.telegram_id,
    user_name: testUser.first_name,
    subject: 'Question regarding video course access',
    messages: [{ sender: 'user', text: 'Where do I find the login link?', timestamp: new Date().toISOString() }]
  });
  assert(ticket.ticket_number.startsWith('TKT-'));
  await db.addTicketMessage(ticket.id, 'admin', 'We have updated your delivery notes with the login portal.');
  const updatedTicket = await db.getTicket(ticket.id);
  assert.strictEqual(updatedTicket.messages.length, 2);
  assert.strictEqual(updatedTicket.status, 'answered');
  console.log(`✅ Flow 16: Support ticket conversation verified (${ticket.ticket_number})`);

  // Flow 17: Admin Management (Promote & Demote)
  const newAdminId = '444555666';
  await db.saveAdmin({
    telegram_id: newAdminId,
    username: 'SubAdminAlice',
    role: 'admin',
    permissions: ['manage_catalog', 'manage_orders'],
    added_by: testSuperAdminId
  });
  const subAdmin = await db.getAdmin(newAdminId);
  assert.strictEqual(subAdmin.role, 'admin');
  await db.removeAdmin(newAdminId);
  const removedSubAdmin = await db.getAdmin(newAdminId);
  assert.strictEqual(removedSubAdmin, null);
  console.log('✅ Flow 17: Admin promotion, permissions, and revocation verified');

  // Flow 18: Broadcast Flow Simulation
  const allUsers = await db.getUsers();
  assert(allUsers.length > 0);
  console.log(`✅ Flow 18: Broadcast targets retrieved (${allUsers.length} users reachable)`);

  // Flow 20: Webhook Deduplication / Idempotency
  const testUpdateId = Date.now();
  const isProcessedBefore = await db.isUpdateProcessed(testUpdateId);
  assert.strictEqual(isProcessedBefore, false);
  await db.markUpdateProcessed(testUpdateId);
  const isProcessedAfter = await db.isUpdateProcessed(testUpdateId);
  assert.strictEqual(isProcessedAfter, true);
  console.log('✅ Flow 20: Webhook update_id deduplication/idempotency verified');

  // Dashboard Stats Check
  const stats = await db.getDashboardStats();
  assert(stats.totalOrders >= 1);
  assert(stats.totalSales >= 999);
  console.log(`\n🎉 ALL 20 CRITICAL BOT FLOWS TESTED AND PASSED SUCCESSFULLY!`);
  console.log(`📊 Total Orders: ${stats.totalOrders}, Completed: ${stats.completedOrders}, Total Sales: ₹${stats.totalSales}`);
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
