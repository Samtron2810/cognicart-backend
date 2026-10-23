/**
 * Phase 17 - Cloud messaging removal and zero-API share-link contracts
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Business = require('../models/Business');
const Campaign = require('../models/Campaign');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');
const webhookMiddleware = require('../middleware/webhookMiddleware');
const { buildOrderShare } = require('../utils/orderShare');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

async function main() {
  console.log('\nPhase 17 — Cloud Messaging Removal Tests\n');

  await test('Provider implementation files and route mounts are absent', () => {
    for (const relative of [
      'config/whatsapp.js',
      'controllers/whatsappController.js',
      'routes/whatsappRoutes.js',
      'services/whatsapp/whatsappService.js',
      'services/whatsapp/webhookService.js',
      'webhooks/whatsappWebhook.js',
    ]) {
      assert.strictEqual(fs.existsSync(path.join(__dirname, '..', relative)), false, relative);
    }
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes/index.js'), 'utf8');
    assert(!routes.includes('whatsappRoutes'));
    assert(!routes.includes('/webhooks/whatsapp'));
    assert(!routes.includes('/api/whatsapp'));
  });

  await test('Business schema has no legacy provider state or credentials', () => {
    for (const field of [
      'whatsappPhone',
      'whatsappConnected',
      'whatsappVerifiedAt',
      'whatsappPhoneNumberId',
      'whatsappVerifyToken',
      'whatsappAccessToken',
      'whatsappWebhookVerified',
    ]) {
      assert.strictEqual(Business.schema.path(field), undefined, field);
    }
  });

  await test('Automated order sources are storefront and Telegram only', () => {
    assert.deepStrictEqual(Order.ORDER_SOURCES, ['storefront', 'telegram', 'manual']);
    assert.deepStrictEqual(Order.AUTOMATIC_SOURCES, ['storefront', 'telegram']);
    assert(Order.MANUAL_CHANNELS.includes('whatsapp'), 'manual source label should remain');
  });

  await test('Messaging and campaigns only accept Telegram transport', async () => {
    const campaign = new Campaign({
      sellerId: 'seller-1',
      title: 'Legacy channel',
      message: 'No automated delivery',
      channel: 'whatsapp',
    });
    await assert.rejects(() => campaign.validate(), (error) => Boolean(error.errors.channel));

    const message = new Message({
      sellerId: 'seller-1',
      channel: 'whatsapp',
      channelUserId: '1',
      direction: 'inbound',
      body: 'hello',
    });
    await assert.rejects(() => message.validate(), (error) => Boolean(error.errors.channel));

    const conversation = new Conversation({
      sellerId: 'seller-1',
      channel: 'whatsapp',
      channelUserId: '1',
    });
    await assert.rejects(() => conversation.validate(), (error) => Boolean(error.errors.channel));
  });

  await test('Only Paystack remains in the generic webhook verifier', () => {
    assert.strictEqual(typeof webhookMiddleware.verifyPaystackSignature, 'function');
    assert.deepStrictEqual(Object.keys(webhookMiddleware), ['verifyPaystackSignature']);
  });

  await test('Environment template contains no removed provider credentials', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    assert(!env.includes('WHATSAPP_'));
    assert(!env.includes('graph.facebook.com'));
  });

  await test('Prefilled wa.me links remain client-opened and credential-free', () => {
    const share = buildOrderShare(
      {
        reference: '#00042',
        customerName: 'Ada',
        customerPhone: '+2348030002000',
        items: [{ name: 'Dress', quantity: 1, subtotal: 25000 }],
        total: 25000,
      },
      { name: 'Ada Store' }
    );
    assert(share.whatsappUrl.startsWith('https://wa.me/2348030002000?text='));
    assert(share.message.includes('#00042'));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main();
