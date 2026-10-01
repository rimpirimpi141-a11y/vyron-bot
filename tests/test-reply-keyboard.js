import assert from 'assert';
import { keyboards } from '../src/bot/keyboards.js';
import { db } from '../src/db/index.js';

async function testReplyKeyboard() {
  console.log('🧪 Testing Telegram Reply Keyboard Layout & Native Button Styles...\n');
  await db.init();

  // 1. Verify structure of 4-Button Toggle Menu (Collapsed State)
  const fourMenu = keyboards.fourButtonMenu();
  assert.strictEqual(fourMenu.is_persistent, undefined, 'is_persistent MUST NOT be true so Telegram allows user to collapse/toggle');
  assert.strictEqual(fourMenu.one_time_keyboard, undefined, 'one_time_keyboard MUST NOT be true so it stays available in 4-square icon');
  assert.strictEqual(fourMenu.resize_keyboard, true, 'resize_keyboard must be true for compact Telegram look');
  assert.strictEqual(fourMenu.keyboard.flat().length, 4, 'Must have exactly 4 buttons');

  assert.strictEqual(fourMenu.keyboard[0][0].text, '🎛️ Menu');
  assert.strictEqual(fourMenu.keyboard[0][0].style, 'primary');
  assert.strictEqual(fourMenu.keyboard[0][1].text, '🤖 AI ASSISTANT');
  assert.strictEqual(fourMenu.keyboard[0][1].style, 'success');
  assert.strictEqual(fourMenu.keyboard[1][0].text, '📦 Orders');
  assert.strictEqual(fourMenu.keyboard[1][0].style, 'primary');
  assert.strictEqual(fourMenu.keyboard[1][1].text, '👤 Account');
  assert.strictEqual(fourMenu.keyboard[1][1].style, 'primary');
  console.log('✅ 1. 4-button collapsed menu structure and styles verified.');

  // 2. Verify structure of Full Menu (Shown on /start)
  const fullMenu = keyboards.fullMenu(false);
  assert.strictEqual(fullMenu.is_persistent, undefined);
  assert.strictEqual(fullMenu.one_time_keyboard, undefined);
  assert.strictEqual(fullMenu.resize_keyboard, true);

  // Row 1: Products & Services (primary)
  assert.strictEqual(fullMenu.keyboard[0][0].text, '🛍️ Products');
  assert.strictEqual(fullMenu.keyboard[0][0].style, 'primary');
  assert.strictEqual(fullMenu.keyboard[0][1].text, '🧑💻 Services');
  assert.strictEqual(fullMenu.keyboard[0][1].style, 'primary');

  // Row 2: Earn Money & Offers (success)
  assert.strictEqual(fullMenu.keyboard[1][0].text, '💰 Earn Money');
  assert.strictEqual(fullMenu.keyboard[1][0].style, 'success');
  assert.strictEqual(fullMenu.keyboard[1][1].text, '🎁 Offers');
  assert.strictEqual(fullMenu.keyboard[1][1].style, 'success');

  // Row 3: Orders & Account (primary)
  assert.strictEqual(fullMenu.keyboard[2][0].text, '📦 Orders');
  assert.strictEqual(fullMenu.keyboard[2][0].style, 'primary');
  assert.strictEqual(fullMenu.keyboard[2][1].text, '👤 Account');
  assert.strictEqual(fullMenu.keyboard[2][1].style, 'primary');

  // Row 4: Support & About (primary)
  assert.strictEqual(fullMenu.keyboard[3][0].text, '🎫 Support');
  assert.strictEqual(fullMenu.keyboard[3][0].style, 'primary');
  assert.strictEqual(fullMenu.keyboard[3][1].text, 'ℹ️ About');
  assert.strictEqual(fullMenu.keyboard[3][1].style, 'primary');

  // Row 5: AI ASSISTANT on dedicated full-width row (success / green)
  assert.strictEqual(fullMenu.keyboard[4].length, 1, 'AI ASSISTANT must be on a dedicated full-width row');
  assert.strictEqual(fullMenu.keyboard[4][0].text, '🤖 AI ASSISTANT');
  assert.strictEqual(fullMenu.keyboard[4][0].style, 'success', 'AI ASSISTANT must have success/green style');

  // Row 6: Close Menu (danger / red)
  assert.strictEqual(fullMenu.keyboard[5][0].text, '❌ Close Menu');
  assert.strictEqual(fullMenu.keyboard[5][0].style, 'danger');
  console.log('✅ 2. Full main menu layout & color styles verified.');

  // 3. Admin Full Menu
  const adminMenu = keyboards.fullMenu(true);
  const flattenedAdmin = adminMenu.keyboard.flat();
  const adminPanelBtn = flattenedAdmin.find(b => b.text === '⚙️ Admin Panel');
  assert(adminPanelBtn, 'Admin full menu must include Admin Panel');
  assert.strictEqual(adminPanelBtn.style, 'danger', 'Admin Panel must have danger/red style');
  console.log('✅ 3. Admin full menu includes ⚙️ Admin Panel [danger].');

  // 4. Verify AI Assistant Reply Menu & Actions
  const aiReply = keyboards.aiReplyMenu();
  assert.strictEqual(aiReply.keyboard[0][0].text, '🔙 Exit AI Assistant');
  assert.strictEqual(aiReply.keyboard[0][0].style, 'danger');

  const aiActions = keyboards.aiReplyActions();
  assert(aiActions.inline_keyboard.flat().some(b => b.callback_data === 'ai:exit'));
  console.log('✅ 4. AI Assistant Reply Menu & Inline actions verified.');

  console.log('\n🎉 ALL REPLY KEYBOARD LAYOUT & COLOR TESTS PASSED!');
  process.exit(0);
}

testReplyKeyboard().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
