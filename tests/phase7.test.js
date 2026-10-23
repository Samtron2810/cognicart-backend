/**
 * Phase 7 Verification Test Suite
 * Tests Paystack Payment Initialization, Commission Splitting, Idempotency, and Automatic Order Reconciliation
 */

process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');
const orderService = require('../services/orders/orderService');
const Payment = require('../models/Payment');

async function runTests() {
  console.log('=== Running Phase 7 Verification Tests ===');

  await setupTestDb();

  const providerTransactions = new Map();
  const providerRefunds = [];
  const paystack = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const input = JSON.parse(raw || '{}');
        providerTransactions.set(input.reference, { ...input, status: 'pending' });
        return res.end(JSON.stringify({
          status: true,
          data: {
            reference: input.reference,
            authorization_url: `https://checkout.paystack.test/${input.reference}`,
            access_code: `access_${input.reference}`,
          },
        }));
      }
      if (req.method === 'GET' && req.url.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(req.url.split('/').pop());
        const input = providerTransactions.get(reference);
        if (!input) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ status: false, message: 'Transaction not found' }));
        }
        return res.end(JSON.stringify({
          status: true,
          data: {
            id: 998877,
            reference,
            status: input.status,
            amount: input.amount,
            currency: input.currency,
          },
        }));
      }
      if (req.method === 'POST' && req.url === '/refund') {
        const input = JSON.parse(raw || '{}');
        providerRefunds.push(input);
        return res.end(JSON.stringify({
          status: true,
          data: { id: `refund_${providerRefunds.length}`, status: 'pending' },
        }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ status: false, message: 'Not found' }));
    });
  });
  await new Promise((resolve) => paystack.listen(0, '127.0.0.1', resolve));
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_phase7';
  process.env.PAYSTACK_API_BASE_URL = `http://127.0.0.1:${paystack.address().port}`;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.API_PUBLIC_URL = baseUrl;

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

    // A repeated initialization without the original browser key must still
    // reuse the order's one pending Paystack transaction.
    const resReuse = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.total,
        email: 'emeka@example.com',
      }),
    });
    const reuseData = await resReuse.json();
    if (reuseData.reference !== initData.reference || reuseData.reused !== true) {
      throw new Error(`Pending payment link was not reused: ${JSON.stringify(reuseData)}`);
    }
    console.log('  [PASS] Repeated initialization reused the pending Paystack link');

    // Simulate successful provider payment before requesting verification.
    providerTransactions.get(initData.reference).status = 'success';

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
    const webhookBody = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: initData.reference,
        amount: 5200000,
      },
    });
    const webhookSignature = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(Buffer.from(webhookBody))
      .digest('hex');
    const resWebhook = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': webhookSignature,
      },
      body: webhookBody,
    });
    const webhookData = await resWebhook.json();
    if (resWebhook.status !== 200 || !webhookData.success) {
      throw new Error(`Paystack webhook failed: ${JSON.stringify(webhookData)}`);
    }
    console.log('  [PASS] Paystack Webhook handled and acknowledged');

    // The browser-facing callback is backend-controlled and verifies with the
    // provider before redirecting to the storefront.
    const callbackRes = await fetch(
      `${baseUrl}/api/payments/callback?reference=${encodeURIComponent(initData.reference)}`,
      { redirect: 'manual' }
    );
    if (callbackRes.status !== 303 || !String(callbackRes.headers.get('location')).includes('payment=success')) {
      throw new Error('Backend payment callback did not verify and redirect successfully');
    }
    console.log('  [PASS] Backend callback verified server-to-server before redirect');

    // A cancelled unpaid order restores stock only once and abandons its local
    // link. If the old hosted page succeeds late, verification queues one refund.
    const beforeCancellation = await productService.getById(product.id, seller.id);
    const cancelOrder = await orderService.create(seller.id, {
      customer: { name: 'Late Payer', phone: '+2348012345000', email: 'late@example.com' },
      items: [{ productId: product.id, quantity: 1 }],
      deliveryAddress: 'Warri, Delta',
    }, `cancel-order-${Date.now()}`);
    const cancelInitRes = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderId: cancelOrder.id, email: 'late@example.com' }),
    });
    const cancelPayment = await cancelInitRes.json();
    if (cancelInitRes.status !== 200) throw new Error(`Cancellation payment initialization failed: ${JSON.stringify(cancelPayment)}`);

    const cancelRes = await fetch(`${baseUrl}/api/orders/${cancelOrder.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderStatus: 'Cancelled' }),
    });
    if (cancelRes.status !== 200) throw new Error(`Order cancellation failed: ${await cancelRes.text()}`);
    const afterCancellation = await productService.getById(product.id, seller.id);
    if (afterCancellation.stock !== beforeCancellation.stock) {
      throw new Error('Cancellation did not restore the reserved product stock');
    }
    const abandoned = await Payment.findOne({ reference: cancelPayment.reference });
    if (!abandoned || abandoned.status !== 'abandoned') throw new Error('Pending payment was not abandoned');

    await orderService.cancel(cancelOrder.id, seller.id, { cancelledBy: 'seller' });
    const afterRetry = await productService.getById(product.id, seller.id);
    if (afterRetry.stock !== afterCancellation.stock) throw new Error('Cancellation retry restored inventory twice');

    providerTransactions.get(cancelPayment.reference).status = 'success';
    const lateVerifyRes = await fetch(`${baseUrl}/api/payments/verify/${cancelPayment.reference}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (lateVerifyRes.status !== 200) throw new Error(`Late payment verification failed: ${await lateVerifyRes.text()}`);
    const lateOrder = await orderService.getById(cancelOrder.id, seller.id);
    const latePayment = await Payment.findOne({ reference: cancelPayment.reference });
    if (lateOrder.orderStatus !== 'Cancelled' || lateOrder.paymentStatus !== 'Paid') {
      throw new Error('Late successful charge was not retained as a cancelled paid order awaiting refund');
    }
    if (latePayment.refundStatus !== 'pending' || providerRefunds.length !== 1) {
      throw new Error('Late cancelled-order charge did not queue exactly one refund');
    }
    await fetch(`${baseUrl}/api/payments/verify/${cancelPayment.reference}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (providerRefunds.length !== 1) throw new Error('Repeated verification queued a duplicate refund');
    console.log('  [PASS] Cancellation restored stock once and safely queued a late-payment refund');

    console.log('=== All Phase 7 Tests Passed Successfully! ===');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => paystack.close(resolve));
    delete process.env.PAYSTACK_API_BASE_URL;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.API_PUBLIC_URL;
    await teardownTestDb();
  }
}

runTests().catch((err) => {
  console.error('Phase 7 Test Suite Failed:', err);
  process.exit(1);
});
