/**
 * Phase 18 - deterministic commerce agent state-machine tests
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const Product = require('../models/Product');
const AgentSession = require('../models/AgentSession');
const productService = require('../services/products/productService');
const searchProducts = require('../services/ai/tools/searchProducts');
const {
  STAGES,
  createDeterministicAgent,
  extractProductQuery,
  parseStructuredRequest,
} = require('../services/ai/deterministicAgent');

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

function memorySessions() {
  const values = new Map();
  return {
    load: async (sellerId, key) => ({ ...(values.get(`${sellerId}:${key}`) || {}) }),
    save: async (sellerId, key, state) => {
      values.set(`${sellerId}:${key}`, JSON.parse(JSON.stringify(state)));
      return state;
    },
    values,
  };
}

function fixtureTools(overrides = {}) {
  const products = {
    sneakers: {
      id: 'sneakers',
      name: 'Sneakers',
      price: 10000,
      stock: 2,
      category: 'Footwear',
      description: 'Comfortable casual trainers',
      variants: [],
    },
    loafers: {
      id: 'loafers',
      name: 'Leather Loafers',
      price: 18000,
      stock: 4,
      category: 'Footwear',
      description: 'Smart leather shoes',
      variants: [],
    },
  };
  return {
    searchProducts: async (sellerId, args) => {
      const query = String(args.query || '').toLowerCase();
      if (!query) return [products.sneakers, products.loafers].slice(0, args.limit || 5);
      if (query.includes('unknown')) return [];
      if (query.includes('shoe') || query.includes('sneaker')) return [products.sneakers];
      if (query.includes('footwear')) return [products.sneakers, products.loafers];
      return [];
    },
    getProduct: async (sellerId, args) => products[args.productId],
    calculateOrderTotal: async (sellerId, args) => {
      const item = args.items[0];
      const subtotal = products[item.productId].price * item.quantity;
      return { subtotal, deliveryFee: 1500, total: subtotal + 1500 };
    },
    createOrder: async (sellerId, args) => ({
      id: 'order-123456',
      orderNumber: 'ORD-0001',
      total: products[args.items[0].productId].price * args.items[0].quantity + 1500,
      deliveryFee: 1500,
      deliveryAddress: args.deliveryAddress,
    }),
    listOrders: async () => [{
      id: '507f1f77bcf86cd799439011',
      reference: '#00001',
      orderNumber: 1,
      orderStatus: 'Pending',
      paymentStatus: 'Pending',
      total: 21500,
      items: [{ name: 'Sneakers', quantity: 2 }],
    }],
    getOrder: async (sellerId, args) => {
      const reference = String(args.orderId);
      const scenarios = {
        '#2': { orderStatus: 'Processing', paymentStatus: 'Paid' },
        '#3': { orderStatus: 'Shipped', paymentStatus: 'Pending' },
        '#4': { orderStatus: 'Cancelled', paymentStatus: 'Refunded' },
      };
      const status = scenarios[reference] || { orderStatus: 'Pending', paymentStatus: 'Pending' };
      return {
        id: reference.startsWith('#') ? '507f1f77bcf86cd799439011' : reference,
        reference: reference.startsWith('#') ? reference : '#00001',
        orderNumber: Number(reference.replace(/\D/g, '')) || 1,
        ...status,
        total: 21500,
        deliveryFee: 1500,
        deliveryAddress: 'heaven',
        items: [{ name: 'Sneakers', quantity: 2 }],
      };
    },
    cancelOrder: async () => ({
      id: '507f1f77bcf86cd799439011',
      reference: '#00001',
      orderStatus: 'Cancelled',
      paymentStatus: 'Pending',
      inventoryRestored: true,
    }),
    createPayment: async () => ({
      amount: 21500,
      reference: 'PSK_TEST',
      authorization_url: 'https://checkout.paystack.test/test',
      reused: true,
    }),
    getBusinessInformation: async () => ({
      deliveryInfo: '1-3 days',
      deliveryFee: 1500,
      freeDeliveryThreshold: 25000,
    }),
    ...overrides,
  };
}

function runInput(body, extra = {}) {
  return {
    sellerId: 'seller-1',
    sessionKey: 'telegram-session',
    customerPhone: '',
    customerName: 'Sam',
    businessName: 'Test Store',
    body,
    toolContext: {
      sellerId: 'seller-1',
      channel: 'telegram',
      channelUserId: '7001',
      customerPhone: extra.customerPhone || '',
    },
    ...extra,
  };
}

async function main() {
  console.log('\nPhase 18 — Deterministic Commerce Agent Tests\n');

  await test('Conversational product phrases are reduced to meaningful search terms', () => {
    assert.strictEqual(extractProductQuery('I want to buy shoe'), 'shoe');
    assert.strictEqual(extractProductQuery('How much is the black Sneakers?'), 'black sneakers');
    assert.deepStrictEqual(parseStructuredRequest('Sneakers, 2, heaven'), {
      productQuery: 'Sneakers',
      quantity: 2,
      address: 'heaven',
      orderIntent: true,
    });
  });

  await test('Ranked product search supports synonyms, category, and effective prices', async () => {
    const original = productService.list;
    productService.list = async () => [
      {
        id: 'p1',
        name: 'Sneakers',
        description: 'Comfortable casual trainers',
        category: 'Footwear',
        price: 10000,
        stock: 3,
        isActive: true,
        discount: { active: true, type: 'percentage', value: 10 },
        variants: [{ id: 'black-42', color: 'Black', size: '42', stock: 2, price: 12000 }],
      },
      {
        id: 'p2',
        name: 'Summer Dress',
        description: 'Light cotton dress',
        category: 'Fashion',
        price: 15000,
        stock: 5,
        discount: { active: false, type: 'percentage', value: 0 },
        variants: [],
      },
    ];
    try {
      const shoeResults = await searchProducts.execute('seller-1', { query: 'shoe' });
      assert.strictEqual(shoeResults.length, 1);
      assert.strictEqual(shoeResults[0].name, 'Sneakers');
      assert.strictEqual(shoeResults[0].price, 9000);

      const detailed = await searchProducts.execute('seller-1', { query: 'black shoe' });
      assert.strictEqual(detailed[0].id, 'p1');
      assert.strictEqual(detailed[0].variants[0].price, 10800);
    } finally {
      productService.list = original;
    }
  });

  await test('A product selection advances through quantity, address, contact, confirmation, order and payment', async () => {
    const sessions = memorySessions();
    const agent = createDeterministicAgent({ tools: fixtureTools(), sessions });

    let result = await agent.run(runInput('I want to buy shoe'));
    assert.strictEqual(result.intent, 'quantity_required');
    assert(result.reply.includes('Sneakers'));
    assert.strictEqual(sessions.values.get('seller-1:telegram-session').stage, STAGES.AWAITING_QUANTITY);

    result = await agent.run(runInput('2'));
    assert.strictEqual(result.intent, 'address_required');

    result = await agent.run(runInput('heaven'));
    assert.strictEqual(result.intent, 'contact_required');
    assert.strictEqual(result.needsContact, true);
    assert(result.reply.includes('Order Summary'));

    result = await agent.resumeAfterContact(runInput('', { customerPhone: '+2348012345678' }));
    assert.strictEqual(result.intent, 'confirm_order');
    assert(result.reply.includes('₦21,500'));

    result = await agent.run(runInput('YES', { customerPhone: '+2348012345678' }));
    assert.strictEqual(result.intent, 'order_confirmed');
    assert.strictEqual(result.orderId, 'order-123456');

    result = await agent.run(runInput('PAY', { customerPhone: '+2348012345678' }));
    assert.strictEqual(result.intent, 'payment_email_required');

    result = await agent.run(runInput('sam@example.com', { customerPhone: '+2348012345678' }));
    assert.strictEqual(result.intent, 'payment_ready');
    assert.strictEqual(result.paymentReused, true);
    assert(result.reply.includes('checkout.paystack.test/test'));
  });

  await test('The reported comma-separated example can reach confirmation without an exact sentence match', async () => {
    const sessions = memorySessions();
    const agent = createDeterministicAgent({ tools: fixtureTools(), sessions });
    const result = await agent.run(runInput('Sneakers, 2, heaven', {
      customerPhone: '+2348012345678',
      sessionKey: 'structured-session',
    }));
    assert.strictEqual(result.intent, 'confirm_order');
    assert(result.reply.includes('Sneakers x2'));
    assert(result.reply.includes('Delivery Address: heaven'));
  });

  await test('A selected product accepts quantity and delivery address in the next sentence', async () => {
    const sessions = memorySessions();
    const agent = createDeterministicAgent({ tools: fixtureTools(), sessions });
    const input = { customerPhone: '+2348012345678', sessionKey: 'sentence-session' };

    const selected = await agent.run(runInput('Sneakers', input));
    assert.strictEqual(selected.intent, 'quantity_required');

    const summary = await agent.run(runInput('I want 2 units delivered to heaven', input));
    assert.strictEqual(summary.intent, 'confirm_order');
    assert(summary.reply.includes('Sneakers x2'));
    assert(summary.reply.includes('Delivery Address: heaven'));
  });

  await test('Ambiguous searches require an explicit product choice and never default to the first item', async () => {
    let selectedProduct = '';
    const tools = fixtureTools({
      searchProducts: async () => [fixtureToolsProducts.sneakers, fixtureToolsProducts.loafers],
      getProduct: async (sellerId, args) => {
        selectedProduct = args.productId;
        return fixtureToolsProducts[args.productId];
      },
    });
    const sessions = memorySessions();
    const agent = createDeterministicAgent({ tools, sessions });

    let result = await agent.run(runInput('footwear', { sessionKey: 'choice-session' }));
    assert.strictEqual(result.intent, 'product_choice_required');
    assert.strictEqual(selectedProduct, '');

    result = await agent.run(runInput('2', { sessionKey: 'choice-session' }));
    assert.strictEqual(selectedProduct, 'loafers');
    assert.strictEqual(result.intent, 'quantity_required');
  });

  await test('Order recovery lists, tracks, resumes, and explicitly cancels owned orders', async () => {
    const sessions = memorySessions();
    const agent = createDeterministicAgent({ tools: fixtureTools(), sessions });
    const input = { customerPhone: '+2348012345678', sessionKey: 'recovery-session' };

    let result = await agent.run(runInput('MY ORDERS', input));
    assert.strictEqual(result.intent, 'orders_listed');
    assert(result.reply.includes('#00001'));

    result = await agent.run(runInput('TRACK #00001', input));
    assert.strictEqual(result.intent, 'order_tracked');
    assert(result.reply.includes('Pending'));

    // A human reference restores lastOrderId even without an earlier draft.
    result = await agent.run(runInput('RESUME #00001', { ...input, sessionKey: 'fresh-recovery-session' }));
    assert.strictEqual(result.intent, 'order_resumed');

    result = await agent.run(runInput('CANCEL ORDER #00001', input));
    assert.strictEqual(result.intent, 'cancellation_confirmation_required');

    result = await agent.run(runInput('YES', input));
    assert.strictEqual(result.intent, 'order_cancelled');
    assert(result.reply.includes('Reserved stock was returned'));
  });

  await test('Recovery reports paid, advanced, cancelled, and refunded outcomes safely', async () => {
    const agent = createDeterministicAgent({ tools: fixtureTools(), sessions: memorySessions() });
    const input = { customerPhone: '+2348012345678', sessionKey: 'safe-outcomes' };

    let result = await agent.run(runInput('TRACK #00002', input));
    assert.strictEqual(result.intent, 'order_tracked');
    assert(result.reply.includes('Payment is confirmed'));
    assert(result.reply.includes('Processing'));

    result = await agent.run(runInput('PAY #00003', input));
    assert.strictEqual(result.intent, 'payment_requires_seller');
    assert(result.reply.includes('Shipped'));

    result = await agent.run(runInput('TRACK #00004', input));
    assert.strictEqual(result.intent, 'order_tracked');
    assert(result.reply.includes('refunded'));

    result = await agent.run(runInput('CANCEL ORDER #00002', input));
    assert.strictEqual(result.intent, 'order_not_cancellable');
  });

  await test('Conversation session schema has tenant uniqueness and automatic expiry', () => {
    assert.strictEqual(AgentSession.schema.path('state').options.select, false);
    const indexes = AgentSession.schema.indexes();
    const unique = indexes.find(([keys, options]) => keys.sellerId === 1 && options.unique);
    const ttl = indexes.find(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0);
    assert(unique, 'expected tenant/session unique index');
    assert(ttl, 'expected session TTL index');
  });

  // Ensure loading this model alongside the catalog model remains intentional.
  assert(Product.schema.path('sellerId'));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

const fixtureToolsProducts = {
  sneakers: {
    id: 'sneakers',
    name: 'Sneakers',
    price: 10000,
    stock: 2,
    category: 'Footwear',
    description: 'Comfortable casual trainers',
    variants: [],
  },
  loafers: {
    id: 'loafers',
    name: 'Leather Loafers',
    price: 18000,
    stock: 4,
    category: 'Footwear',
    description: 'Smart leather shoes',
    variants: [],
  },
};

main();
