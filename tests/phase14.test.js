/**
 * Phase 14 Verification Test Suite
 *
 * Seller order hub: manually logged cross-channel orders, source separation,
 * custom items, optional stock tracking, offline payment guards, dashboard
 * totals, short references, and no-API WhatsApp share links.
 */

const http = require('http');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');

async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { response, data };
}

async function runTests() {
  console.log('=== Running Phase 14 Verification Tests ===');
  await setupTestDb();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const sellerResult = await authService.register({
      businessName: 'Warri Style House',
      email: `orders_${Date.now()}@wabac.test`,
      password: 'Password123',
      phone: '+2348030001001',
    });
    const seller = sellerResult.seller;
    const token = sellerResult.token;

    const strangerResult = await authService.register({
      businessName: 'Another Shop',
      email: `stranger_${Date.now()}@wabac.test`,
      password: 'Password123',
      phone: '+2348030001002',
    });

    const product = await productService.create(seller.id, {
      name: 'Leather Tote Bag',
      price: 25000,
      stock: 10,
      category: 'Bags',
    });

    // 1. Only authenticated sellers may exercise seller-entered pricing.
    const unauthorized = await jsonRequest(`${baseUrl}/api/orders/manual`, {
      method: 'POST',
      body: {
        customer: { name: 'Ada Okonkwo', phone: '08030002000' },
        items: [{ name: 'Bespoke Scarf', price: 5000, quantity: 1 }],
      },
    });
    if (unauthorized.response.status !== 401) {
      throw new Error(`Expected manual-order auth guard (401), got ${unauthorized.response.status}`);
    }
    console.log('  [PASS] Manual price-entry endpoint is seller-authenticated');

    // 2. Log a mixed catalog/off-catalog Instagram order and reserve only the
    // linked catalog item's stock.
    const created = await jsonRequest(`${baseUrl}/api/orders/manual`, {
      method: 'POST',
      token,
      body: {
        customer: {
          name: 'Ada Okonkwo',
          phone: '08030002000',
          email: 'ada@example.com',
        },
        deliveryAddress: '12 Airport Road, Warri',
        sourceChannel: 'instagram',
        sourceNote: 'DM from @ada_styles',
        items: [
          { productId: product.id, price: 23000, quantity: 2 },
          { name: 'Bespoke Silk Scarf', price: 7000, quantity: 1 },
        ],
        deliveryFee: 2000,
        paymentStatus: 'Paid',
        paymentMethod: 'bank_transfer',
        expectedDeliveryDate: '2030-06-15',
        adjustInventory: true,
        notes: 'Call before dispatch',
      },
    });

    if (created.response.status !== 201) {
      throw new Error(`Manual order failed: ${created.response.status} ${JSON.stringify(created.data)}`);
    }
    const manual = created.data;
    if (manual.source !== 'manual' || manual.sourceChannel !== 'instagram' || !manual.isManual) {
      throw new Error('Manual provenance was not persisted');
    }
    if (manual.reference !== '#00001' || manual.orderNumber !== 1) {
      throw new Error(`Expected first short reference #00001, got ${manual.reference}`);
    }
    if (manual.subtotal !== 53000 || manual.total !== 55000) {
      throw new Error(`Manual totals were not computed server-side: ${JSON.stringify(manual)}`);
    }
    if (manual.items[1].productId || !manual.items[1].isCustomItem) {
      throw new Error('Off-catalog item was not represented as a custom item');
    }
    if (!manual.paidAt || manual.paymentMethod !== 'bank_transfer') {
      throw new Error('Seller-recorded offline payment was not captured');
    }

    const stockAfterManual = await productService.getById(product.id, seller.id);
    if (stockAfterManual.stock !== 8) {
      throw new Error(`Opt-in manual stock reservation expected 8, got ${stockAfterManual.stock}`);
    }
    console.log('  [PASS] Cross-channel manual order supports custom items, negotiated prices, and optional stock');

    // 3. Public/automatic checkout cannot self-declare manual source, arbitrary
    // price, or Paid state. Catalog price remains authoritative.
    const automatic = await jsonRequest(`${baseUrl}/api/orders`, {
      method: 'POST',
      body: {
        sellerId: seller.id,
        source: 'manual',
        paymentStatus: 'Paid',
        customer: { name: 'Buyer Two', phone: '+2348030002001' },
        items: [{ productId: product.id, price: 1, quantity: 1 }],
        deliveryFee: 0,
      },
    });
    if (automatic.response.status !== 201) {
      throw new Error(`Automatic checkout failed: ${JSON.stringify(automatic.data)}`);
    }
    if (
      automatic.data.source !== 'storefront' ||
      automatic.data.paymentStatus !== 'Pending' ||
      automatic.data.items[0].price !== 25000
    ) {
      throw new Error('Automatic checkout accepted a manual source, price, or payment override');
    }
    if (automatic.data.reference !== '#00002') {
      throw new Error(`Expected sequential reference #00002, got ${automatic.data.reference}`);
    }
    console.log('  [PASS] Automatic checkout cannot use manual-order privileges');

    // 4. Manual vs automatic views remain one dashboard but are filterable.
    const manualList = await jsonRequest(`${baseUrl}/api/orders?source=manual`, { token });
    const automaticList = await jsonRequest(`${baseUrl}/api/orders?source=automatic`, { token });
    if (manualList.data.length !== 1 || manualList.data[0].id !== manual.id) {
      throw new Error('Manual source filter returned the wrong rows');
    }
    if (automaticList.data.length !== 1 || automaticList.data[0].id !== automatic.data.id) {
      throw new Error('Automatic source filter returned the wrong rows');
    }

    const summary = await jsonRequest(`${baseUrl}/api/orders/summary`, { token });
    if (summary.data.totals.orders !== 2 || summary.data.totals.paidRevenue !== 55000) {
      throw new Error(`Order summary is wrong: ${JSON.stringify(summary.data)}`);
    }
    console.log('  [PASS] Unified dashboard cleanly separates manual and automatic sources');

    // 5. Correct item quantities; inventory reconciles by delta (2 reserved ->
    // 1 reserved), rather than deducting everything a second time.
    const corrected = await jsonRequest(`${baseUrl}/api/orders/manual/${manual.id}`, {
      method: 'PATCH',
      token,
      body: {
        items: [
          { productId: product.id, price: 23000, quantity: 1 },
          { name: 'Bespoke Silk Scarf', price: 7000, quantity: 2 },
        ],
        deliveryFee: 1500,
        sourceNote: 'Corrected after voice note',
      },
    });
    if (corrected.response.status !== 200 || corrected.data.total !== 38500) {
      throw new Error(`Manual correction failed: ${JSON.stringify(corrected.data)}`);
    }
    const stockAfterCorrection = await productService.getById(product.id, seller.id);
    if (stockAfterCorrection.stock !== 8) {
      // The automatic order also reserved one: initial 10 - corrected manual 1 - automatic 1 = 8.
      throw new Error(`Inventory reconciliation expected 8, got ${stockAfterCorrection.stock}`);
    }
    console.log('  [PASS] Manual corrections reconcile totals and stock deltas');

    // 6. Offline payment endpoint can only touch a manual order and enforces
    // tenant isolation with indistinguishable 404s.
    const pending = await jsonRequest(`${baseUrl}/api/orders/manual/${manual.id}/payment`, {
      method: 'PATCH',
      token,
      body: { paymentStatus: 'Pending', paymentMethod: 'cash' },
    });
    if (pending.response.status !== 200 || pending.data.paidAt !== null) {
      throw new Error('Manual payment correction failed');
    }

    const automaticPaymentAttempt = await jsonRequest(
      `${baseUrl}/api/orders/manual/${automatic.data.id}/payment`,
      { method: 'PATCH', token, body: { paymentStatus: 'Paid' } }
    );
    if (automaticPaymentAttempt.response.status !== 404) {
      throw new Error('Manual payment route altered or disclosed an automatic order');
    }

    const crossTenantAttempt = await jsonRequest(`${baseUrl}/api/orders/manual/${manual.id}/payment`, {
      method: 'PATCH',
      token: strangerResult.token,
      body: { paymentStatus: 'Paid' },
    });
    if (crossTenantAttempt.response.status !== 404) {
      throw new Error('Cross-tenant manual order access was not hidden');
    }
    console.log('  [PASS] Offline payment and tenant boundaries are enforced');

    // 7. wa.me feature is a link composer, not an API integration or send.
    const share = await jsonRequest(`${baseUrl}/api/orders/${manual.id}/share`, { token });
    if (
      share.response.status !== 200 ||
      !share.data.whatsappUrl.startsWith('https://wa.me/2348030002000?text=') ||
      !share.data.message.includes('#00001') ||
      !share.data.message.includes('Warri Style House')
    ) {
      throw new Error(`Share payload is invalid: ${JSON.stringify(share.data)}`);
    }
    console.log('  [PASS] Copyable summary and no-API wa.me deep link generated');

    console.log('\n=== Phase 14 Tests Passed ===');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await teardownTestDb();
  }
}

runTests().catch((error) => {
  console.error('\nPhase 14 Tests Failed:', error);
  process.exit(1);
});
