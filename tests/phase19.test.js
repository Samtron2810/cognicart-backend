/**
 * Phase 19 - secure Paystack verification and order recovery contracts
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const Payment = require('../models/Payment');
const paystackClient = require('../services/payments/paystackClient');
const paymentService = require('../services/payments/paymentService');
const orderService = require('../services/orders/orderService');
const createPaymentTool = require('../services/ai/tools/createPayment');
const listOrdersTool = require('../services/ai/tools/listOrders');
const getOrderTool = require('../services/ai/tools/getOrder');
const cancelOrderTool = require('../services/ai/tools/cancelOrder');
const { buildToolContext } = require('../services/ai/toolGuards');
const { verifyPaystackSignature } = require('../middleware/webhookMiddleware');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.stack || error.message}`);
  }
}

function patch(target, replacements) {
  const originals = {};
  for (const [key, value] of Object.entries(replacements)) {
    originals[key] = target[key];
    target[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) target[key] = value;
  };
}

async function main() {
  console.log('\nPhase 19 — Payment Security & Order Recovery Tests\n');

  await test('Paystack client authenticates and reads provider verification, initialization, and refunds', async () => {
    const seen = [];
    const provider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, raw });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/transaction/initialize') {
          const input = JSON.parse(raw);
          return res.end(JSON.stringify({ status: true, data: {
            reference: input.reference,
            authorization_url: 'https://checkout.paystack.test/access',
            access_code: 'access',
          } }));
        }
        if (req.url.startsWith('/transaction/verify/')) {
          return res.end(JSON.stringify({ status: true, data: {
            id: 55,
            reference: 'PSK_SAFE',
            status: 'success',
            amount: 100000,
            currency: 'NGN',
          } }));
        }
        if (req.url === '/refund') {
          return res.end(JSON.stringify({ status: true, data: { id: 9, status: 'pending' } }));
        }
        res.statusCode = 404;
        return res.end(JSON.stringify({ status: false, message: 'Not found' }));
      });
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_secure';
    process.env.PAYSTACK_API_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
    try {
      await paystackClient.initializeTransaction({ reference: 'PSK_SAFE', amount: 100000, email: 'a@b.com' });
      const verified = await paystackClient.verifyTransaction('PSK_SAFE');
      await paystackClient.createRefund({ transaction: 'PSK_SAFE' });
      assert.strictEqual(verified.status, 'success');
      assert.strictEqual(seen.length, 3);
      assert(seen.every((request) => request.authorization === 'Bearer sk_test_secure'));
    } finally {
      await new Promise((resolve) => provider.close(resolve));
      delete process.env.PAYSTACK_API_BASE_URL;
      delete process.env.PAYSTACK_SECRET_KEY;
    }
  });

  await test('Payment callback configuration fails closed without a public backend URL', () => {
    const previous = process.env.API_PUBLIC_URL;
    delete process.env.API_PUBLIC_URL;
    try {
      assert.throws(() => paymentService.checkoutCallbackUrl(), /API_PUBLIC_URL/);
      process.env.API_PUBLIC_URL = 'https://api.example.test/';
      assert.strictEqual(
        paymentService.checkoutCallbackUrl(),
        'https://api.example.test/api/payments/callback'
      );
    } finally {
      if (previous === undefined) delete process.env.API_PUBLIC_URL;
      else process.env.API_PUBLIC_URL = previous;
    }
  });

  await test('Provider success must match local reference, amount, currency, and successful status', () => {
    const transaction = { reference: 'PSK_SAFE', amount: 1000, currency: 'NGN' };
    const valid = { reference: 'PSK_SAFE', amount: 100000, currency: 'NGN', status: 'success' };
    paymentService.validateProviderSuccess(transaction, valid);
    assert.throws(
      () => paymentService.validateProviderSuccess(transaction, { ...valid, amount: 99900 }),
      /amount/
    );
    assert.throws(
      () => paymentService.validateProviderSuccess(transaction, { ...valid, reference: 'OTHER' }),
      /reference/
    );
    assert.throws(
      () => paymentService.validateProviderSuccess(transaction, { ...valid, status: 'pending' }),
      /pending/
    );
  });

  await test('Webhook signature uses exact raw bytes and rejects a mismatch', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_signature';
    const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"PSK_SAFE"}}');
    const validSignature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    let nextCalled = false;
    verifyPaystackSignature(
      { headers: { 'x-paystack-signature': validSignature }, rawBody, body: JSON.parse(rawBody.toString()) },
      { status: () => ({ json: () => { throw new Error('valid signature rejected'); } }) },
      () => { nextCalled = true; }
    );
    assert.strictEqual(nextCalled, true);

    let status;
    verifyPaystackSignature(
      { headers: { 'x-paystack-signature': 'bad' }, rawBody, body: {} },
      { status: (code) => { status = code; return { json: () => {} }; } },
      () => { throw new Error('invalid signature accepted'); }
    );
    assert.strictEqual(status, 401);
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  await test('Telegram payment tool requires a real email and never synthesizes one', async () => {
    const order = {
      id: '507f1f77bcf86cd799439011',
      sellerId: 'seller-1',
      customerPhone: '+2348012345678',
      customerEmail: '',
      channel: 'telegram',
      channelUserId: '7001',
      orderStatus: 'Pending',
      paymentStatus: 'Pending',
      total: 1000,
      subtotal: 1000,
      deliveryFee: 0,
    };
    let initialized;
    const restoreOrders = patch(orderService, { getById: async () => order });
    const restorePayments = patch(paymentService, {
      initialize: async (payload) => {
        initialized = payload;
        return {
          reference: 'PSK_SAFE',
          authorization_url: 'https://checkout.paystack.test/access',
          transaction: {},
          reused: true,
        };
      },
    });
    const context = buildToolContext({
      sellerId: 'seller-1',
      channel: 'telegram',
      channelUserId: '7001',
      customerPhone: '+2348012345678',
    });
    try {
      await assert.rejects(
        createPaymentTool.execute('seller-1', { orderId: order.id }, context),
        /valid email/
      );
      const result = await createPaymentTool.execute(
        'seller-1',
        { orderId: order.id, email: 'buyer@example.com' },
        context
      );
      assert.strictEqual(initialized.email, 'buyer@example.com');
      assert.strictEqual(result.reused, true);
    } finally {
      restorePayments();
      restoreOrders();
    }
  });

  await test('Order recovery tools preserve the exact conversation identity scope', async () => {
    const context = buildToolContext({
      sellerId: 'seller-1',
      channel: 'telegram',
      channelUserId: '7001',
      customerPhone: '+2348012345678',
    });
    const captured = [];
    const restore = patch(orderService, {
      listForCounterparty: async (sellerId, ctx) => {
        captured.push(ctx);
        return [];
      },
      resolveForCounterparty: async (sellerId, identifier, ctx) => {
        captured.push(ctx);
        return {
          id: '507f1f77bcf86cd799439011',
          reference: '#00001',
          orderStatus: 'Pending',
          paymentStatus: 'Pending',
          items: [],
          total: 1000,
        };
      },
      cancelForCounterparty: async (sellerId, identifier, ctx) => {
        captured.push(ctx);
        return {
          id: '507f1f77bcf86cd799439011',
          reference: '#00001',
          orderStatus: 'Cancelled',
          paymentStatus: 'Pending',
          inventoryRestoredAt: new Date(),
        };
      },
    });
    try {
      await listOrdersTool.execute('seller-1', {}, context);
      await getOrderTool.execute('seller-1', { orderId: '#00001' }, context);
      await cancelOrderTool.execute('seller-1', { orderId: '#00001' }, context);
      assert.strictEqual(captured.length, 3);
      assert(captured.every((ctx) => ctx.channel === 'telegram' && ctx.channelUserId === '7001'));
    } finally {
      restore();
    }
  });

  await test('Payment schema permits only one pending transaction per order', () => {
    const pendingIndex = Payment.schema.indexes().find(([keys, options]) =>
      keys.orderId === 1 && options.unique && options.partialFilterExpression
    );
    assert(pendingIndex, 'expected unique pending payment index');
    assert(Payment.schema.path('authorizationUrl'));
    assert(Payment.schema.path('refundStatus'));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main();
