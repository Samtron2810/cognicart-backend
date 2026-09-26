/**
 * Phase 7 Verification Test Suite
 * Tests Paystack Payment Initialization, Commission Splitting, Idempotency, and Automatic Order Reconciliation
 */

const http = require('http');
const app = require('../server');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');
const orderService = require('../services/orders/orderService');

async function runTests() {
  console.log('=== Running Phase 7 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup Seller, Product, and Order
    const sellerRes = await authService.register({
      businessName: 'Apex Electronics NG',
      email: `apex_${Date.now()}@electronics.ng`,
      password: 'Password123!',
      phone: '+2348066662222',
    });
    const seller = sellerRes.seller;
    const token = sellerRes.token;

    const product = await productService.create(seller.id, {
      name: 'Wireless ANC Headphones',
      price: 50000,
      stock: 10,
      category: 'Electronics',
    });

    const order = await orderService.create(seller.id, {
      customer: {
        name: 'Emeka Nwosu',
        phone: '+2348077771111',
        address: '5 Broad Street, Lagos Island',
      },
      items: [{ productId: product.id, quantity: 1 }],
      deliveryFee: 2000,
    });

    if (order.total !== 52000 || order.paymentStatus !== 'Pending') {
      throw new Error(`Order setup failed: ${JSON.stringify(order)}`);
    }

    // 2. Initialize Payment & Check Commission Splitting
    console.log('Testing Payment Initialization & Revenue Split...');
    const idemKey = `idem_pay_${Date.now()}`;
    const resInit = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.total,
        email: 'emeka@example.com',
      }),
    });
    const initData = await resInit.json();

    if (resInit.status !== 200 || !initData.reference || !initData.transaction) {
      throw new Error(`Payment initialization failed: ${resInit.status} - ${JSON.stringify(initData)}`);
    }

    const tx = initData.transaction;
    // Total: 52000. 5% platform fee = 2600. 1.5% paystack fee = 780. Seller amount = 52000 - 2600 - 780 = 48620.
    if (tx.platformFee !== 2600) throw new Error(`Platform fee incorrect, expected 2600, got ${tx.platformFee}`);
    if (tx.paystackFee !== 780) throw new Error(`Paystack fee incorrect, expected 780, got ${tx.paystackFee}`);
    if (tx.sellerAmount !== 48620) throw new Error(`Seller amount incorrect, expected 48620, got ${tx.sellerAmount}`);
    console.log('  [PASS] Revenue split calculated correctly (Platform: ₦2,600, Paystack: ₦780, Seller: ₦48,620)');

    // 3. Payment Idempotency Check
    console.log('Testing Payment Initialization Idempotency...');
    const resIdem = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.total,
        email: 'emeka@example.com',
      }),
    });
    const idemData = await resIdem.json();
    if (idemData.reference !== initData.reference) {
      throw new Error('Payment idempotency failed: different reference returned for same key');
    }
    console.log('  [PASS] Payment idempotency verified');

    // 4. Verify Payment & Automatic Order Reconciliation
    console.log('Testing Payment Verification & Automatic Order Status Update...');
    const resVerify = await fetch(`${baseUrl}/api/payments/verify/${initData.reference}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const verifyData = await resVerify.json();

    if (resVerify.status !== 200 || verifyData.status !== 'success') {
      throw new Error(`Verification failed: ${JSON.stringify(verifyData)}`);
    }

    // Verify order was automatically transitioned to Paid
    const reconciledOrder = await orderService.getById(order.id, seller.id);
    if (reconciledOrder.paymentStatus !== 'Paid') {
      throw new Error(`Order was not reconciled to Paid status, is: ${reconciledOrder.paymentStatus}`);
    }
    if (reconciledOrder.paymentReference !== initData.reference) {
      throw new Error(`Order payment reference mismatch: ${reconciledOrder.paymentReference}`);
    }
    console.log('  [PASS] Payment verified and Order #' + order.id.slice(-6) + ' transitioned to "Paid"');

    // 5. Test Paystack Webhook Event Handler
    console.log('Testing Paystack Webhook Handler (charge.success)...');
    const resWebhook = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': 'mock',
      },
      body: JSON.stringify({
        event: 'charge.success',
        data: {
          reference: initData.reference,
          amount: 5200000,
        },
      }),
    });
    const webhookData = await resWebhook.json();
    if (resWebhook.status !== 200 || !webhookData.success) {
      throw new Error(`Paystack webhook failed: ${JSON.stringify(webhookData)}`);
    }
    console.log('  [PASS] Paystack Webhook handled and acknowledged');

    console.log('=== All Phase 7 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 7 Test Suite Failed:', err);
  process.exit(1);
});
