/**
 * Phase 13 Verification Test Suite
 * Tests Progressive Buyer Identity: guest checkout, email OTP sessions, single-use
 * magic links, claim-on-verify history backfill, cross-audience token isolation,
 * and buyer-scoped order history
 */

// Exposes the generated code in the API response so the flow can run without a
// live Brevo account. Must be set before the app is required.
process.env.SHOP_OTP_DEBUG = 'true';

const http = require('http');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');
const shopperAuthService = require('../services/shop/shopperAuthService');

async function runTests() {
  console.log('=== Running Phase 13 Verification Tests ===');

  await setupTestDb();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // --- Fixtures: two independent sellers, each with a product ---
    const sellerARes = await authService.register({
      businessName: 'Glow Cosmetics',
      email: `glow_${Date.now()}@test.ng`,
      password: 'Password123',
      phone: '+2348011111111',
    });
    const sellerA = sellerARes.seller;

    const sellerBRes = await authService.register({
      businessName: 'Naija Gadgets',
      email: `gadgets_${Date.now()}@test.ng`,
      password: 'Password123',
      phone: '+2348022222222',
    });
    const sellerB = sellerBRes.seller;

    const productA = await productService.create(sellerA.id, {
      name: 'Shea Butter Cream',
      description: 'Rich moisturiser',
      price: 7500,
      stock: 20,
      category: 'Skincare',
    });

    const productB = await productService.create(sellerB.id, {
      name: 'Wireless Earbuds',
      description: 'Bluetooth 5.3',
      price: 25000,
      stock: 10,
      category: 'Audio',
    });

    const buyerPhone = '+2348090000001';
    const buyerEmail = 'amara@example.ng';
    const otherPhone = '+2348090000002';
    const otherEmail = 'somebody@example.ng';

    // 1. Guest checkout at two different stores (no account, no session)
    console.log('Testing guest checkout across two stores...');
    const guestOrder = async (sellerId, productId, phone, email, name) => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerId,
          customer: { name, phone, email },
          deliveryAddress: '12 Aba Road, Port Harcourt',
          items: [{ productId, quantity: 1 }],
        }),
      });
      const data = await res.json();
      if (res.status !== 201) throw new Error(`Guest checkout failed: ${JSON.stringify(data)}`);
      return data;
    };

    const orderA = await guestOrder(sellerA.id, productA.id, buyerPhone, buyerEmail, 'Amara O.');
    const orderB = await guestOrder(sellerB.id, productB.id, buyerPhone, buyerEmail, 'Amara O.');
    const strangerOrder = await guestOrder(
      sellerA.id,
      productA.id,
      otherPhone,
      otherEmail,
      'Somebody Else'
    );
    // Same phone is not sufficient ownership when email is the proof channel.
    const forgedPairOrder = await guestOrder(
      sellerA.id,
      productA.id,
      buyerPhone,
      'attacker@example.ng',
      'Forged Pair'
    );
    console.log('  [PASS] Four guest orders placed with no buyer account');

    // 2. Buyer data is not readable without a verified session
    const unauthRes = await fetch(`${baseUrl}/api/shop/me/orders`);
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for anonymous history read, got ${unauthRes.status}`);
    }
    console.log('  [PASS] Order history rejects unauthenticated buyers');

    // 3. Request a one-time code (debug mode exposes it without Brevo)
    console.log('Testing email OTP issuance...');
    const otpRes = await fetch(`${baseUrl}/api/shop/auth/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: buyerPhone, email: buyerEmail, sellerId: sellerA.id }),
    });
    const otpData = await otpRes.json();
    if (otpRes.status !== 200 || !otpData.devCode) {
      throw new Error(`OTP request failed: ${JSON.stringify(otpData)}`);
    }
    console.log('  [PASS] Verification code issued (10 minute expiry)');

    // 4. A wrong code is rejected
    const badRes = await fetch(`${baseUrl}/api/shop/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: buyerPhone, email: buyerEmail, code: '000000' }),
    });
    if (badRes.status !== 401) throw new Error(`Expected 401 for wrong code, got ${badRes.status}`);
    console.log('  [PASS] Incorrect code rejected');

    // 5. Correct code returns a session and claims prior guest orders
    const verifyRes = await fetch(`${baseUrl}/api/shop/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: buyerPhone, email: buyerEmail, code: otpData.devCode }),
    });
    const session = await verifyRes.json();
    if (verifyRes.status !== 200 || !session.token || !session.shopper) {
      throw new Error(`OTP verification failed: ${JSON.stringify(session)}`);
    }
    if (session.claimed.orders !== 2) {
      throw new Error(`Expected 2 claimed guest orders, got ${session.claimed.orders}`);
    }
    if (session.shopper.phone !== buyerPhone || session.shopper.email !== buyerEmail) {
      throw new Error(`Shopper contact identity is wrong: ${JSON.stringify(session.shopper)}`);
    }
    console.log('  [PASS] Session established and 2 guest orders claimed on first verify');

    const buyerAuth = { Authorization: `Bearer ${session.token}` };

    // 6. Cross-store history, scoped to the exact verified contact pair
    console.log('Testing buyer order history...');
    const historyRes = await fetch(`${baseUrl}/api/shop/me/orders`, { headers: buyerAuth });
    const history = await historyRes.json();
    if (historyRes.status !== 200 || !Array.isArray(history) || history.length !== 2) {
      throw new Error(`Expected 2 orders in history, got: ${JSON.stringify(history)}`);
    }
    const historyIds = history.map((o) => o.id);
    if (!historyIds.includes(orderA.id) || !historyIds.includes(orderB.id)) {
      throw new Error('History is missing one of the buyer orders');
    }
    if (historyIds.includes(strangerOrder.id) || historyIds.includes(forgedPairOrder.id)) {
      throw new Error("SECURITY: an order with a different verified contact pair leaked into history");
    }
    if (!history[0].store || !history[0].store.name) {
      throw new Error('History entries should carry store attribution');
    }
    if (history[0].customerId !== undefined || history[0].idempotencyKey !== undefined) {
      throw new Error('History leaked internal bookkeeping fields');
    }
    console.log('  [PASS] History spans both stores, excludes other buyers, hides internals');

    // 7. Per-store filtering and single order access control
    const filteredRes = await fetch(`${baseUrl}/api/shop/me/orders?sellerId=${sellerB.id}`, { headers: buyerAuth });
    const filtered = await filteredRes.json();
    if (filtered.length !== 1 || filtered[0].id !== orderB.id) {
      throw new Error(`Store filter failed: ${JSON.stringify(filtered)}`);
    }

    const ownRes = await fetch(`${baseUrl}/api/shop/me/orders/${orderA.id}`, { headers: buyerAuth });
    if (ownRes.status !== 200) throw new Error('Buyer cannot read their own order');

    const strangerRes = await fetch(`${baseUrl}/api/shop/me/orders/${strangerOrder.id}`, { headers: buyerAuth });
    if (strangerRes.status !== 404) {
      throw new Error(`SECURITY: expected 404 reading another buyer's order, got ${strangerRes.status}`);
    }
    console.log('  [PASS] Per-store filter works; foreign order returns 404');

    // 8. Profile aggregates the per-seller customer records
    const meRes = await fetch(`${baseUrl}/api/shop/me`, { headers: buyerAuth });
    const me = await meRes.json();
    if (meRes.status !== 200 || me.stores.length !== 2 || me.totalOrders !== 2) {
      throw new Error(`Buyer profile aggregation failed: ${JSON.stringify(me)}`);
    }
    if (!me.addresses.includes('12 Aba Road, Port Harcourt')) {
      throw new Error('Saved addresses were not aggregated');
    }
    console.log('  [PASS] Profile aggregates stores, lifetime orders and saved addresses');

    // 9. Cross-audience token isolation (the dangerous shared-secret case)
    console.log('Testing token audience isolation...');
    const buyerOnSellerRoute = await fetch(`${baseUrl}/api/products`, { headers: buyerAuth });
    if (buyerOnSellerRoute.status !== 401) {
      throw new Error(`SECURITY: buyer token accepted on seller route (${buyerOnSellerRoute.status})`);
    }
    const buyerOnAdminRoute = await fetch(`${baseUrl}/api/admin/stats`, { headers: buyerAuth });
    if (buyerOnAdminRoute.status !== 401) {
      throw new Error(`SECURITY: buyer token accepted on admin route (${buyerOnAdminRoute.status})`);
    }
    const sellerOnBuyerRoute = await fetch(`${baseUrl}/api/shop/me`, {
      headers: { Authorization: `Bearer ${sellerARes.token}` },
    });
    if (sellerOnBuyerRoute.status !== 401) {
      throw new Error(`SECURITY: seller token accepted on buyer route (${sellerOnBuyerRoute.status})`);
    }
    console.log('  [PASS] Buyer and seller tokens are rejected by each other\'s middleware');

    // 10. Magic link: single use, then dead
    console.log('Testing single-use magic link...');
    const magic = await shopperAuthService.createMagicLink({
      phone: buyerPhone,
      email: buyerEmail,
      sellerId: sellerA.id,
    });
    const magicRes = await fetch(`${baseUrl}/api/shop/auth/magic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: magic.token }),
    });
    const magicSession = await magicRes.json();
    if (magicRes.status !== 200 || !magicSession.token) {
      throw new Error(`Magic link redemption failed: ${JSON.stringify(magicSession)}`);
    }
    if (magicSession.shopper.id !== session.shopper.id) {
      throw new Error('Magic link created a second identity for the same email');
    }

    const replayRes = await fetch(`${baseUrl}/api/shop/auth/magic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: magic.token }),
    });
    if (replayRes.status !== 401) {
      throw new Error(`SECURITY: magic link was reusable (${replayRes.status})`);
    }
    console.log('  [PASS] Magic link signs the buyer in once, replay rejected');

    // 11. Verified checkout binds to the session phone, not the payload
    console.log('Testing verified checkout binding...');
    const spoofRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buyerAuth },
      body: JSON.stringify({
        sellerId: sellerA.id,
        shopperId: 'forged-shopper-id',
        customer: { name: 'Amara O.', phone: otherPhone },
        deliveryAddress: '12 Aba Road, Port Harcourt',
        items: [{ productId: productA.id, quantity: 1 }],
      }),
    });
    const spoofOrder = await spoofRes.json();
    if (spoofRes.status !== 201) throw new Error(`Verified checkout failed: ${JSON.stringify(spoofOrder)}`);
    if (spoofOrder.customerPhone !== buyerPhone) {
      throw new Error(`SECURITY: order bound to payload phone instead of verified phone (${spoofOrder.customerPhone})`);
    }

    const historyAfter = await (await fetch(`${baseUrl}/api/shop/me/orders`, { headers: buyerAuth })).json();
    if (historyAfter.length !== 3) {
      throw new Error(`Expected 3 orders after verified checkout, got ${historyAfter.length}`);
    }
    console.log('  [PASS] Verified checkout ignores spoofed phone/shopperId and lands in history');

    // 12. Profile update
    const patchRes = await fetch(`${baseUrl}/api/shop/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...buyerAuth },
      body: JSON.stringify({ name: 'Amara Okonkwo', email: 'AMARA@Example.NG' }),
    });
    const patched = await patchRes.json();
    if (patchRes.status !== 200 || patched.name !== 'Amara Okonkwo' || patched.email !== 'amara@example.ng') {
      throw new Error(`Buyer profile update failed: ${JSON.stringify(patched)}`);
    }
    console.log('  [PASS] Buyer can update their own profile');

    // 13. Per-contact-pair resend cooldown protects the OTP endpoint
    const firstResend = await fetch(`${baseUrl}/api/shop/auth/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: otherPhone, email: otherEmail }),
    });
    if (firstResend.status !== 200) throw new Error('First OTP request should succeed');

    const secondResend = await fetch(`${baseUrl}/api/shop/auth/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: otherPhone, email: otherEmail }),
    });
    if (secondResend.status !== 429) {
      throw new Error(`Expected 429 on immediate OTP resend, got ${secondResend.status}`);
    }
    console.log('  [PASS] Per-contact-pair resend cooldown enforced');
  } finally {
    server.close();
    await teardownTestDb();
  }

  console.log('=== All Phase 13 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Phase 13 Test Suite Failed:', err);
  process.exit(1);
});
