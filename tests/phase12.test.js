/**
 * Phase 12 Verification Test Suite
 * Tests Production Hardening: Security Headers, NoSQL Injection Defenses, Rate Limiting, Health Probes, and Full End-to-End Flow
 */

const http = require('http');
const express = require('express');
const app = require('../server');
const { createRateLimiter } = require('../middleware/rateLimiter');

async function runTests() {
  console.log('=== Running Phase 12 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Test Production Security Headers
    console.log('Testing Production Security Headers...');
    const rootRes = await fetch(`${baseUrl}/health`);
    const headers = rootRes.headers;

    if (headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error('Missing or invalid X-Content-Type-Options header');
    }
    if (headers.get('x-frame-options') !== 'DENY') {
      throw new Error('Missing or invalid X-Frame-Options header');
    }
    if (!headers.get('content-security-policy')) {
      throw new Error('Missing Content-Security-Policy header');
    }
    if (!headers.get('strict-transport-security')) {
      throw new Error('Missing Strict-Transport-Security header');
    }
    if (headers.get('x-powered-by')) {
      throw new Error('X-Powered-By header should be removed in production');
    }
    console.log('  [PASS] All production security headers verified (CSP, HSTS, X-Frame-Options, No-Sniff, No-Fingerprint)');

    // 2. Test NoSQL Injection Operator Defenses
    console.log('Testing NoSQL Operator Injection Defenses...');
    // Attempt body injection with $gt operator
    const injectBodyRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: { '$gt': '' }, password: 'password' }),
    });
    const injectBodyData = await injectBodyRes.json();
    if (injectBodyRes.status !== 400 || !injectBodyData.message.includes('operator detected')) {
      throw new Error(`Failed to block body NoSQL operator injection: ${JSON.stringify(injectBodyData)}`);
    }

    // Attempt query injection with $where operator
    const injectQueryRes = await fetch(`${baseUrl}/api/products?$where=evilScript()`);
    const injectQueryData = await injectQueryRes.json();
    if (injectQueryRes.status !== 400) {
      throw new Error('Failed to block query string NoSQL operator injection');
    }
    console.log('  [PASS] Prohibited NoSQL query operators ($gt, $where) blocked safely');

    // 3. Test Rate Limiter Middleware
    console.log('Testing Rate Limiting Middleware (HTTP 429 Too Many Requests)...');
    const testApp = express();
    const limiter = createRateLimiter({
      windowMs: 5000,
      max: 3,
      message: 'Test rate limit exceeded',
    });
    testApp.use(limiter);
    testApp.get('/test-limit', (req, res) => res.json({ ok: true }));

    const limitServer = http.createServer(testApp);
    await new Promise((resolve) => limitServer.listen(0, '127.0.0.1', resolve));
    const limitPort = limitServer.address().port;

    try {
      // First 3 requests should succeed
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://127.0.0.1:${limitPort}/test-limit`);
        if (res.status !== 200) throw new Error(`Request ${i + 1} failed unexpectedly`);
      }

      // 4th request must be throttled with 429
      const throttledRes = await fetch(`http://127.0.0.1:${limitPort}/test-limit`);
      const throttledData = await throttledRes.json();
      if (
        throttledRes.status !== 429 ||
        !throttledData.message.includes('Test rate limit exceeded') ||
        !throttledRes.headers.get('retry-after')
      ) {
        throw new Error(`Rate limiter failed to throttle: status=${throttledRes.status}, data=${JSON.stringify(throttledData)}`);
      }
      console.log('  [PASS] Rate limiter accurately throttled excess requests with HTTP 429 and Retry-After header');
    } finally {
      limitServer.close();
    }

    // 4. Test Production Health Probes (Live & Ready)
    console.log('Testing Health Probes (/health/live & /health/ready)...');
    const liveRes = await fetch(`${baseUrl}/health/live`);
    const liveData = await liveRes.json();
    if (liveRes.status !== 200 || liveData.status !== 'alive') {
      throw new Error(`Liveness probe failed: ${JSON.stringify(liveData)}`);
    }

    const readyRes = await fetch(`${baseUrl}/health/ready`);
    const readyData = await readyRes.json();
    if (readyRes.status !== 200 || readyData.status !== 'ready' || !readyData.checks.memory) {
      throw new Error(`Readiness probe failed: ${JSON.stringify(readyData)}`);
    }
    console.log(`  [PASS] Container liveness (/health/live) and deep readiness (/health/ready) verified (Heap: ${readyData.checks.memory.heapUsedMB} MB)`);

    // 5. Test Full System End-to-End Workflow (Registration -> Storefront -> Order -> Paystack -> Notifications)
    console.log('Testing Full End-to-End Production Customer Journey...');

    // A. Register seller
    const e2eSellerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `e2e_${Date.now()}@haven.ng`,
        password: 'Password123',
        businessName: 'Royal Silk Store',
        phone: '+2348011223344',
      }),
    });
    const e2eSeller = await e2eSellerRes.json();
    const token = e2eSeller.token;

    // B. Add product
    const prodRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pure Mulberry Silk Scarf',
        price: 18000,
        stock: 10,
        category: 'Accessories',
      }),
    });
    const product = await prodRes.json();

    // C. Public storefront browsing
    const storeRes = await fetch(`${baseUrl}/api/storefront/${e2eSeller.seller.id}/products`);
    const storeCatalog = await storeRes.json();
    if (storeCatalog.products.length !== 1 || storeCatalog.products[0].id !== product.id) {
      throw new Error('Public storefront failed to display product');
    }

    // D. Order Placement
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Halima Yusuf', phone: '+2348091112233', address: 'Abuja, FCT' },
        items: [{ productId: product.id, quantity: 2 }],
      }),
    });
    const order = await orderRes.json();
    if (order.total !== 36000 + 0) { // >= 25k qualifies for free delivery
      throw new Error(`Unexpected order total: ${order.total}`);
    }

    // E. Paystack Initialization
    const payRes = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.total,
        email: 'halima@yusuf.ng',
      }),
    });
    const payData = await payRes.json();

    // F. Payment Verification & Order Reconciliation
    const verifyRes = await fetch(`${baseUrl}/api/payments/verify/${payData.reference}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const verified = await verifyRes.json();
    if (verified.status !== 'success') {
      throw new Error('Payment verification failed');
    }

    // G. Verify Order status became Paid
    const orderCheckRes = await fetch(`${baseUrl}/api/orders`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const orders = await orderCheckRes.json();
    const completedOrder = orders.find((o) => o.id === order.id);
    if (!completedOrder || completedOrder.paymentStatus !== 'Paid') {
      throw new Error('Order was not reconciled to Paid');
    }

    console.log('  [PASS] Full End-to-End customer journey executed cleanly under production hardening');

  } finally {
    server.close();
  }

  console.log('=== All Phase 12 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Phase 12 Test Suite Failed:', err);
  process.exit(1);
});
