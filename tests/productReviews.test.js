'use strict';

/**
 * Product reviews: who is allowed to write one.
 *
 * The rule the UI promises is "only buyers may review", so it has to be true
 * on the server regardless of what the client sends. These tests drive
 * reviewService directly with stubbed models — no MongoDB — and cover the
 * three ways someone could try to review a product they did not buy:
 *
 *   1. no delivered order at all
 *   2. a delivered order that does not contain the product
 *   3. someone else's delivered order
 *
 * plus the honest paths and the one-review-per-product-per-order guard.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-review-suite-0123456789';

const BUYER = '64c000000000000000000001';
const OTHER_BUYER = '64c000000000000000000002';
const SELLER = '64c0000000000000000000a1';
const ORDER = '64c0000000000000000000b1';
const PRODUCT = '64c0000000000000000000c1';
const OTHER_PRODUCT = '64c0000000000000000000c2';

// --- state the stubs read ---
let orders = [];
let reviews = [];
let created = [];
let duplicateOnCreate = false;

/** Mongoose-ish query builder: every terminal returns a promise. */
function queryOn(rows) {
  const builder = {
    select: () => builder,
    sort: () => builder,
    skip: () => builder,
    limit: () => builder,
    lean: async () => rows,
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
}

const OrderStub = {
  find: (filter) => {
    let rows = orders.filter((o) => String(o.shopperId) === String(filter.shopperId));
    if (filter.orderStatus) rows = rows.filter((o) => o.orderStatus === filter.orderStatus);
    if (filter.sellerId) rows = rows.filter((o) => String(o.sellerId) === String(filter.sellerId));
    if (filter['items.productId']) {
      const wanted = String(filter['items.productId']);
      rows = rows.filter((o) => (o.items || []).some((i) => String(i.productId || '') === wanted));
    }
    return queryOn(rows);
  },
  // findById must be synchronous and expose .lean()
  findById: (id) => ({
    lean: async () => orders.find((o) => String(o._id) === String(id)) || null,
  }),
};

const ReviewStub = {
  find: (filter) => {
    let rows = reviews.filter((r) => String(r.shopperId) === String(filter.shopperId));
    if (filter.productId !== undefined) {
      rows = rows.filter((r) => String(r.productId || '') === String(filter.productId || ''));
    }
    if (filter.orderId && filter.orderId.$in) {
      const allowed = new Set(filter.orderId.$in.map(String));
      rows = rows.filter((r) => allowed.has(String(r.orderId)));
    }
    return queryOn(rows);
  },
  countDocuments: async () => 0,
  // Mirrors the $match + $avg pipeline recomputeSellerRating uses.
  aggregate: async (pipeline) => {
    const match = (pipeline.find((stage) => stage.$match) || {}).$match || {};
    const rows = reviews.filter(
      (r) =>
        (match.sellerId === undefined || String(r.sellerId) === String(match.sellerId)) &&
        (match.status === undefined || r.status === match.status)
    );
    if (!rows.length) return [];
    return [
      {
        _id: null,
        average: rows.reduce((sum, r) => sum + r.rating, 0) / rows.length,
        count: rows.length,
      },
    ];
  },
  create: async (doc) => {
    if (duplicateOnCreate) {
      const err = new Error('duplicate');
      err.code = 11000;
      throw err;
    }
    created.push(doc);
    return { ...doc, _id: 'rev-1', toJSON: () => ({ ...doc, _id: 'rev-1' }) };
  },
};

// findOne/findById are synchronous and return a chainable with .lean().
let businessUpdates = [];
const BusinessStub = {
  findOne: () => ({ select: () => ({ lean: async () => ({ sellerId: SELLER }) }) }),
  updateOne: async (_filter, update) => {
    businessUpdates.push(update.$set);
    return { acknowledged: true };
  },
};

const ShopperStub = {
  findById: () => ({ select: () => ({ lean: async () => ({ name: 'Adaobi Nwosu' }) }) }),
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('models/Order')) return OrderStub;
  if (request.endsWith('models/Review')) return ReviewStub;
  if (request.endsWith('models/Business')) return BusinessStub;
  if (request.endsWith('models/Shopper')) return ShopperStub;
  if (request.includes('ranking/rankingService')) {
    // Scoring itself has its own suite (ranking.test.js); here we only need
    // it to exist so recomputeSellerRating can run to completion.
    return {
      refreshSellerRanking: async () => undefined,
      recomputeSeller: async () => undefined,
      scoreSeller: async () => undefined,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const reviewService = require('../services/reviews/reviewService');
Module._load = originalLoad;

// Most tests here are about who may write, not about scoring, so the
// rating recompute is stubbed by default and restored where it matters.
const realRecompute = reviewService.recomputeSellerRating.bind(reviewService);
reviewService.recomputeSellerRating = async () => undefined;

function deliveredOrder(overrides = {}) {
  return {
    _id: ORDER,
    shopperId: BUYER,
    sellerId: SELLER,
    orderStatus: 'Delivered',
    orderNumber: 124,
    createdAt: new Date('2026-09-01'),
    customerName: 'Adaobi Nwosu',
    items: [
      { productId: PRODUCT, name: 'Ankara Wrap Dress', price: 18000, quantity: 1 },
      { productId: OTHER_PRODUCT, name: 'Leather Tote', price: 24000, quantity: 1 },
    ],
    ...overrides,
  };
}

function reset() {
  orders = [deliveredOrder()];
  reviews = [];
  created = [];
  businessUpdates = [];
  duplicateOnCreate = false;
}

// ─────────────────────────── eligibility ───────────────────────────

test('a buyer who received the product may review it', async () => {
  reset();
  const result = await reviewService.getProductEligibility(BUYER, PRODUCT);

  assert.equal(result.canReview, true);
  assert.equal(result.hasPurchased, true);
  assert.equal(result.eligibleOrders.length, 1);
  assert.equal(result.eligibleOrders[0].orderId, ORDER);
  assert.equal(result.eligibleOrders[0].itemSummary, 'Ankara Wrap Dress');
  assert.equal(result.eligibleOrders[0].sellerId, SELLER);
});

test('someone who never bought the product cannot review it', async () => {
  reset();
  const result = await reviewService.getProductEligibility(OTHER_BUYER, PRODUCT);

  assert.equal(result.canReview, false);
  assert.equal(result.hasPurchased, false, 'drives the "buy this product to review it" message');
});

test('an undelivered order does not earn a review', async () => {
  reset();
  orders = [deliveredOrder({ orderStatus: 'Processing' })];

  const result = await reviewService.getProductEligibility(BUYER, PRODUCT);
  assert.equal(result.canReview, false);
  assert.equal(result.hasPurchased, false);
});

test('buying a different item from the same order is not enough', async () => {
  reset();
  orders = [deliveredOrder({ items: [{ productId: OTHER_PRODUCT, name: 'Leather Tote' }] })];

  const result = await reviewService.getProductEligibility(BUYER, PRODUCT);
  assert.equal(result.canReview, false);
});

test('already reviewed means no second go, but the page can say why', async () => {
  reset();
  reviews = [{ shopperId: BUYER, orderId: ORDER, productId: PRODUCT }];

  const result = await reviewService.getProductEligibility(BUYER, PRODUCT);
  assert.equal(result.canReview, false);
  assert.equal(result.hasPurchased, true);
  assert.equal(result.hasReviewed, true, 'distinct from never having bought it');
});

test('a store review on the same order does not consume the product review', async () => {
  reset();
  // productId null = the store review.
  reviews = [{ shopperId: BUYER, orderId: ORDER, productId: null }];

  const result = await reviewService.getProductEligibility(BUYER, PRODUCT);
  assert.equal(result.canReview, true, 'rating the shop must not block rating the item');
});

test('no session and no product both yield nothing', async () => {
  reset();
  assert.equal((await reviewService.getProductEligibility(null, PRODUCT)).canReview, false);
  assert.equal((await reviewService.getProductEligibility(BUYER, null)).canReview, false);
});

// ───────────────────────────── writing ─────────────────────────────

test('a genuine buyer can post a product review', async () => {
  reset();
  await reviewService.create(BUYER, {
    sellerId: SELLER,
    orderId: ORDER,
    productId: PRODUCT,
    rating: 5,
    comment: 'Fabric is lovely.',
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].productId, PRODUCT);
  assert.equal(created[0].productName, 'Ankara Wrap Dress', 'snapshotted at write time');
  assert.equal(created[0].rating, 5);
});

test('the server refuses a product that is not in the order', async () => {
  reset();
  await assert.rejects(
    () =>
      reviewService.create(BUYER, {
        sellerId: SELLER,
        orderId: ORDER,
        productId: '64c0000000000000000000ff',
        rating: 5,
      }),
    /only review a product you bought/i,
  );
  assert.equal(created.length, 0);
});

test("the server refuses another buyer's order", async () => {
  reset();
  // The attacker knows a real order id and a real product id.
  await assert.rejects(
    () =>
      reviewService.create(OTHER_BUYER, {
        sellerId: SELLER,
        orderId: ORDER,
        productId: PRODUCT,
        rating: 5,
      }),
    /not found/i,
  );
  assert.equal(created.length, 0);
});

test('the server refuses an undelivered order', async () => {
  reset();
  orders = [deliveredOrder({ orderStatus: 'Pending' })];

  await assert.rejects(
    () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, productId: PRODUCT, rating: 4 }),
    /delivered/i,
  );
  assert.equal(created.length, 0);
});

test('a duplicate is reported against the product, not the order', async () => {
  reset();
  duplicateOnCreate = true;

  await assert.rejects(
    () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, productId: PRODUCT, rating: 4 }),
    /already reviewed this product/i,
  );
});

test('store reviews still work and are stored with a null product', async () => {
  reset();
  await reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating: 4, comment: 'Quick delivery' });

  assert.equal(created.length, 1);
  assert.equal(created[0].productId, null, 'null marks a store review');
  assert.equal(created[0].productName, '');
});

test('ratings outside 1-5 are rejected before anything is read', async () => {
  reset();
  for (const rating of [0, 6, 2.5, 'five']) {
    await assert.rejects(
      () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, productId: PRODUCT, rating }),
      /whole number between 1 and 5/i,
    );
  }
  assert.equal(created.length, 0);
});

test('an anonymous caller cannot write at all', async () => {
  reset();
  await assert.rejects(
    () => reviewService.create(null, { sellerId: SELLER, orderId: ORDER, productId: PRODUCT, rating: 5 }),
    /verified buyer session/i,
  );
});

// ───────────────────────────── reading ─────────────────────────────

test('reviewing a product does not use up the store review for that order', async () => {
  reset();
  reviews = [{ shopperId: BUYER, orderId: ORDER, productId: PRODUCT }];

  const result = await reviewService.getEligibility(BUYER, SELLER);
  assert.equal(result.canReview, true, 'the shop itself has still not been reviewed');
  assert.equal(result.eligibleOrders.length, 1);
});

test('a store review does use up the store review for that order', async () => {
  reset();
  reviews = [{ shopperId: BUYER, orderId: ORDER, productId: null }];

  const result = await reviewService.getEligibility(BUYER, SELLER);
  assert.equal(result.canReview, false);
});

// ───────────────────── ranking signal ─────────────────────

test('BOTH store and product reviews feed the seller rating that drives ranking', async () => {
  reset();
  reviews = [
    { sellerId: SELLER, rating: 5, status: 'published', productId: null },      // store
    { sellerId: SELLER, rating: 3, status: 'published', productId: PRODUCT },   // product
  ];

  const result = await realRecompute(SELLER);

  assert.equal(result.ratingCount, 2, 'a product review must count toward the store');
  assert.equal(result.ratingAvg, 4, '(5 + 3) / 2');
  assert.deepEqual(businessUpdates.at(-1), { ratingAvg: 4, ratingCount: 2 });
});

test('a product review alone is enough to give a seller a rating', async () => {
  reset();
  reviews = [{ sellerId: SELLER, rating: 4, status: 'published', productId: PRODUCT }];

  const result = await realRecompute(SELLER);
  assert.equal(result.ratingCount, 1);
  assert.equal(result.ratingAvg, 4);
});

test('hidden reviews of either kind are excluded from the rating', async () => {
  reset();
  reviews = [
    { sellerId: SELLER, rating: 5, status: 'published', productId: PRODUCT },
    { sellerId: SELLER, rating: 1, status: 'hidden', productId: null },
    { sellerId: SELLER, rating: 1, status: 'hidden', productId: PRODUCT },
  ];

  const result = await realRecompute(SELLER);
  assert.equal(result.ratingCount, 1, 'moderation must still remove a rating from the score');
  assert.equal(result.ratingAvg, 5);
});

test('listing reviews for no product returns an empty summary, not a crash', async () => {
  reset();
  const result = await reviewService.listForProduct(null);
  assert.deepEqual(result.reviews, []);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.average, null);
});
