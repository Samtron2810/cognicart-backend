/**
 * Phase 5 - removed Cloud messaging surface and retained no-API sharing
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');
const { buildOrderShare } = require('../utils/orderShare');

async function runTests() {
  console.log('=== Running Phase 5 Removal & Share-Link Tests ===');
  await setupTestDb();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const sellerRes = await authService.register({
      businessName: 'Naija Spice Hub',
      email: `spice_${Date.now()}@hub.ng`,
      password: 'Password123!',
      phone: '+2348099999999',
    });
    const token = sellerRes.token;

    const removedEndpoints = [
      '/api/whatsapp/config',
      '/api/whatsapp/webhook',
      '/webhooks/whatsapp',
      '/api/webhooks/whatsapp',
    ];
    for (const endpoint of removedEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 404) {
        throw new Error(`${endpoint} must be removed (received ${response.status})`);
      }
    }
    console.log('  [PASS] Legacy provider endpoints are absent');

    const patch = await fetch(`${baseUrl}/api/business`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        phone: '+2348099999999',
        whatsappConnected: true,
        whatsappAccessToken: 'must-not-be-stored',
        whatsappPhoneNumberId: 'must-not-be-stored',
      }),
    });
    const business = await patch.json();
    if (patch.status !== 200 || business.phone !== '+2348099999999') {
      throw new Error('Public business phone should remain editable');
    }
    for (const removed of ['whatsappConnected', 'whatsappAccessToken', 'whatsappPhoneNumberId']) {
      if (business[removed] !== undefined) throw new Error(`${removed} must not exist`);
    }
    console.log('  [PASS] Provider credentials/state cannot be persisted');

    const telegramConfig = await fetch(`${baseUrl}/api/telegram/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const telegram = await telegramConfig.json();
    if (telegramConfig.status !== 200 || telegram.data.connected !== false) {
      throw new Error(`Telegram configuration route failed: ${JSON.stringify(telegram)}`);
    }
    console.log('  [PASS] Telegram is the automated messaging configuration surface');

    const share = buildOrderShare(
      {
        id: 'order-1',
        reference: '#00001',
        customerName: 'Ada',
        customerPhone: '+2348030002000',
        items: [{ name: 'Suya Spice', quantity: 1, subtotal: 3500 }],
        total: 3500,
      },
      { name: 'Naija Spice Hub' }
    );
    if (!share.whatsappUrl.startsWith('https://wa.me/2348030002000?text=')) {
      throw new Error('No-API wa.me share link was not retained');
    }
    console.log('  [PASS] Client-opened wa.me sharing remains available');

    const removedFiles = [
      'controllers/whatsappController.js',
      'routes/whatsappRoutes.js',
      'config/whatsapp.js',
      'services/whatsapp/whatsappService.js',
      'webhooks/whatsappWebhook.js',
    ];
    for (const relative of removedFiles) {
      if (fs.existsSync(path.join(__dirname, '..', relative))) {
        throw new Error(`${relative} should have been deleted`);
      }
    }
    console.log('  [PASS] Provider implementation files are deleted');

    console.log('=== All Phase 5 Tests Passed Successfully! ===');
  } finally {
    server.close();
    await teardownTestDb();
  }
}

runTests().catch((error) => {
  console.error('Phase 5 Test Suite Failed:', error);
  process.exit(1);
});
