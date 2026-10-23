/**
 * Phase 15 Verification Test Suite
 *
 * Provider-neutral notification dispatch, Brevo payloads, storefront email
 * snapshots, magic links, secure email OTP routing, failure isolation, and the
 * rule that manually logged orders never auto-send.
 */

process.env.BREVO_API_KEY = 'test_brevo_key';
process.env.BREVO_SENDER_EMAIL = 'notifications@wabac.test';
process.env.BREVO_SENDER_NAME = 'WABAC Notifications';
process.env.SHOP_OTP_DEBUG = 'false';

const http = require('http');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');

const deliveries = [];

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { response, data };
}

async function waitForDelivery(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = deliveries.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function runTests() {
  console.log('=== Running Phase 15 Verification Tests ===');
  await setupTestDb();

  const brevoServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      deliveries.push({
        headers: req.headers,
        payload: JSON.parse(body || '{}'),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: `brevo-test-${deliveries.length}` }));
    });
  });
  await new Promise((resolve) => brevoServer.listen(0, '127.0.0.1', resolve));
  process.env.BREVO_API_URL = `http://127.0.0.1:${brevoServer.address().port}/v3/smtp/email`;

  const apiServer = http.createServer(app);
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${apiServer.address().port}`;

  try {
    const registration = await authService.register({
      businessName: 'Benin Beauty Store',
      email: `brevo_${Date.now()}@wabac.test`,
      password: 'Password123',
      phone: '+2348036000000',
    });
    const seller = registration.seller;
    const sellerToken = registration.token;

    const product = await productService.create(seller.id, {
      name: 'Body Butter',
      price: 8500,
      stock: 20,
      category: 'Skincare',
    });

    const buyer = {
      name: 'Eseosa Igbinovia',
      phone: '+2348036000001',
      email: 'eseosa@example.com',
      address: '12 Airport Road, Benin City',
    };

    // 1. Storefront order snapshots the email and emits a Brevo confirmation
    // carrying a single-use tracking link.
    const created = await requestJson(`${baseUrl}/api/orders`, {
      method: 'POST',
      body: {
        sellerId: seller.id,
        customer: buyer,
        items: [{ productId: product.id, quantity: 1 }],
      },
    });
    if (created.response.status !== 201) {
      throw new Error(`Storefront order failed: ${JSON.stringify(created.data)}`);
    }
    if (created.data.customerEmail !== buyer.email) {
      throw new Error('Order did not snapshot the customer email');
    }

    const confirmation = await waitForDelivery(
      (entry) =>
        entry.payload.to &&
        entry.payload.to[0].email === buyer.email &&
        entry.payload.tags &&
        entry.payload.tags.includes('order-created')
    );
    if (!confirmation) throw new Error('Brevo order confirmation was not captured');
    if (confirmation.headers['api-key'] !== process.env.BREVO_API_KEY) {
      throw new Error('Brevo API key header was not sent');
    }
    if (!confirmation.payload.htmlContent.includes('/track?t=')) {
      throw new Error('Confirmation email is missing its magic tracking link');
    }
    if (!confirmation.payload.textContent.includes(created.data.reference)) {
      throw new Error('Confirmation email is missing the human order reference');
    }
    console.log('  [PASS] Storefront order confirmation delivered through Brevo');

    // 2. OTP is routed only to the email already bound to the phone at checkout.
    const otpStartCount = deliveries.length;
    const otp = await requestJson(`${baseUrl}/api/shop/auth/request-otp`, {
      method: 'POST',
      body: { phone: buyer.phone, email: buyer.email, sellerId: seller.id },
    });
    if (otp.response.status !== 200 || otp.data.devCode) {
      throw new Error(`Production OTP response is invalid: ${JSON.stringify(otp.data)}`);
    }

    const otpEmail = await waitForDelivery(
      (entry, index) =>
        index >= otpStartCount &&
        entry.payload.to &&
        entry.payload.to[0].email === buyer.email &&
        entry.payload.tags &&
        entry.payload.tags.includes('buyer-otp')
    );
    if (!otpEmail) throw new Error('Brevo OTP email was not captured');
    const match = otpEmail.payload.textContent.match(/code is (\d{6})/i);
    if (!match) throw new Error('Could not extract the six-digit code from the OTP email');

    const verified = await requestJson(`${baseUrl}/api/shop/auth/verify-otp`, {
      method: 'POST',
      body: { phone: buyer.phone, email: buyer.email, code: match[1] },
    });
    if (verified.response.status !== 200 || !verified.data.token) {
      throw new Error(`Email OTP verification failed: ${JSON.stringify(verified.data)}`);
    }
    console.log('  [PASS] Brevo OTP establishes a passwordless buyer session');

    // 3. An attacker cannot redirect the same phone's code to another email.
    // Response remains generic and no email is emitted.
    const beforeRedirectAttempt = deliveries.length;
    const redirect = await requestJson(`${baseUrl}/api/shop/auth/request-otp`, {
      method: 'POST',
      body: {
        phone: buyer.phone,
        email: 'attacker@example.com',
        sellerId: seller.id,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (redirect.response.status !== 200 || deliveries.length !== beforeRedirectAttempt) {
      throw new Error('Unassociated email received an OTP or exposed account existence');
    }
    console.log('  [PASS] OTP destination cannot be redirected to an arbitrary email');

    // 4. Fulfilment updates use the same provider-neutral event path.
    const shipped = await requestJson(`${baseUrl}/api/orders/${created.data.id}/status`, {
      method: 'PATCH',
      token: sellerToken,
      body: { status: 'Shipped' },
    });
    if (shipped.response.status !== 200) throw new Error('Could not mark order Shipped');
    const statusEmail = await waitForDelivery(
      (entry) => entry.payload.tags && entry.payload.tags.includes('order-status_changed')
    );
    if (!statusEmail || !statusEmail.payload.subject.includes('Shipped')) {
      throw new Error('Shipped notification did not pass through Brevo');
    }
    console.log('  [PASS] Fulfilment event delivered through the dispatcher');

    // 5. Manually logged orders are records, not automatic outbound sends.
    const beforeManual = deliveries.length;
    const manual = await requestJson(`${baseUrl}/api/orders/manual`, {
      method: 'POST',
      token: sellerToken,
      body: {
        customer: {
          name: 'Manual Customer',
          phone: '+2348036000002',
          email: 'manual@example.com',
        },
        sourceChannel: 'instagram',
        items: [{ name: 'Custom Gift Box', price: 12000, quantity: 1 }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (manual.response.status !== 201 || deliveries.length !== beforeManual) {
      throw new Error('Manual order unexpectedly triggered automatic delivery');
    }
    console.log('  [PASS] Manual orders never auto-send notifications');

    // 6. Provider outage is isolated from the commerce write path. Point Brevo
    // at the now-closed receiver: order creation must still succeed.
    await new Promise((resolve) => brevoServer.close(resolve));
    const outageOrder = await requestJson(`${baseUrl}/api/orders`, {
      method: 'POST',
      body: {
        sellerId: seller.id,
        customer: {
          name: 'Outage Buyer',
          phone: '+2348036000003',
          email: 'outage@example.com',
        },
        items: [{ productId: product.id, quantity: 1 }],
      },
    });
    if (outageOrder.response.status !== 201) {
      throw new Error(`Brevo outage rolled back checkout: ${JSON.stringify(outageOrder.data)}`);
    }
    console.log('  [PASS] Brevo failure cannot roll back a durable order');

    console.log('\n=== Phase 15 Tests Passed ===');
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    if (brevoServer.listening) {
      await new Promise((resolve) => brevoServer.close(resolve));
    }
    await teardownTestDb();
  }
}

runTests().catch((error) => {
  console.error('\nPhase 15 Tests Failed:', error);
  process.exit(1);
});
