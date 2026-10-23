/**
 * Seller reviews — the eligibility gates.
 *
 * These are the rules that stop the rating system being gamed, so they are
 * pinned against the service itself rather than trusted to the UI. Mongoose
 * statics are mocked, so no database is needed.
 *
 * Run: node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Review = require('../models/Review');
const Order = require('../models/Order');
const Business = require('../models/Business');
const Shopper = require('../models/Shopper');
const rankingService = require('../services/ranking/rankingService');
const reviewService = require('../services/reviews/reviewService');

const BUYER = new mongoose.Types.ObjectId().toString();
const OTHER_BUYER = new mongoose.Types.ObjectId().toString();
const ORDER = new mongoose.Types.ObjectId().toString();
const SELLER = 'seller-vivid';

/** A delivered order belonging to BUYER, placed with SELLER. */
const goodOrder = {
  _id: ORDER,
  shopperId: BUYER,
  sellerId: SELLER,
  orderStatus: 'Delivered',
  customerName: 'Adaobi Nwosu',
  items: [{ name: 'Linen shirt' }],
};

/**
 * Stub everything the happy path touches. Individual tests override the
 * order to express the thing they are actually testing.
 */
function stub(t, { order = goodOrder, createThrows = null } = {}) {
  t.mock.method(Order, 'findById', () => ({ lean: async () => order }));
  t.mock.method(Business, 'findOne', () => ({
    select: () => ({ lean: async () => ({ sellerId: SELLER }) }),
  }));
  t.mock.method(Shopper, 'findById', () => ({
    select: () => ({ lean: async () => ({ name: 'Adaobi Nwosu' }) }),
  }));

  const created = [];
  t.mock.method(Review, 'create', async (doc) => {
    if (createThrows) throw createThrows;
    created.push(doc);
    return { ...doc, _id: new mongoose.Types.ObjectId().toString(), toJSON: () => ({ ...doc }) };
  });

  // recomputeSellerRating's dependencies
  t.mock.method(Review, 'aggregate', async () => [{ _id: null, average: 4.5, count: 2 }]);
  t.mock.method(Business, 'updateOne', async () => ({ acknowledged: true }));
  t.mock.method(rankingService, 'refreshSellerRanking', async () => ({ updated: true }));

  return { created };
}

test('a delivered order from this buyer can be reviewed', async (t) => {
  const { created } = stub(t);
  const review = await reviewService.create(BUYER, {
    sellerId: SELLER,
    orderId: ORDER,
    rating: 5,
    comment: 'Arrived in two days, exactly as described.',
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].rating, 5);
  assert.equal(created[0].sellerId, SELLER);
  assert.equal(review.isVerifiedPurchase, true);
});

test("a buyer cannot review someone else's order", async (t) => {
  stub(t, { order: { ...goodOrder, shopperId: OTHER_BUYER } });
  await assert.rejects(
    () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating: 5 }),
    // 404, not 403: the response must not confirm that the order exists.
    (error) => error.statusCode === 404
  );
});

test('a review cannot be pointed at a different seller', async (t) => {
  // Without this check a buyer could launder a real purchase from store A
  // into a five-star review for store B.
  stub(t, { order: { ...goodOrder, sellerId: 'seller-someone-else' } });
  await assert.rejects(
    () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating: 5 }),
    (error) => error.statusCode === 400 && /not placed with this store/i.test(error.message)
  );
});

test('an undelivered order cannot be reviewed', async (t) => {
  for (const status of ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Cancelled']) {
    stub(t, { order: { ...goodOrder, orderStatus: status } });
    await assert.rejects(
      () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating: 5 }),
      (error) => error.statusCode === 400 && /delivered/i.test(error.message),
      `status ${status} should not be reviewable`
    );
    t.mock.restoreAll();
  }
});

test('the same order cannot be reviewed twice', async (t) => {
  // The unique index is the real guard; the service turns it into a message.
  const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  stub(t, { createThrows: duplicate });
  await assert.rejects(
    () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating: 5 }),
    (error) => error.statusCode === 400 && /already reviewed/i.test(error.message)
  );
});

test('ratings outside 1-5, and fractional ratings, are rejected', async (t) => {
  for (const rating of [0, 6, -1, 4.5, 'five', null, undefined, NaN]) {
    stub(t);
    await assert.rejects(
      () => reviewService.create(BUYER, { sellerId: SELLER, orderId: ORDER, rating }),
      (error) => error.statusCode === 400,
      `rating ${String(rating)} should be rejected`
    );
    t.mock.restoreAll();
  }
});

test('an anonymous visitor cannot review at all', async (t) => {
  stub(t);
  await assert.rejects(
    () => reviewService.create(null, { sellerId: SELLER, orderId: ORDER, rating: 5 }),
    (error) => error.statusCode === 400 && /verified buyer/i.test(error.message)
  );
});

test('a public review never exposes the buyer account or full name', () => {
  const published = reviewService.toPublicReview({
    _id: 'r1',
    sellerId: SELLER,
    shopperId: BUYER,
    orderId: ORDER,
    buyerName: 'Adaobi Nwosu',
    rating: 5,
    comment: 'Great',
    status: 'published',
  });

  assert.equal(published.shopperId, undefined, 'the buyer account id must never be published');
  assert.equal(published.buyerName, 'Adaobi N.', 'surnames are reduced to an initial');
  assert.equal(published.id, 'r1');
  assert.equal(published.isVerifiedPurchase, true);
});

test('a single-word buyer name survives anonymisation', () => {
  const published = reviewService.toPublicReview({ _id: 'r2', buyerName: 'Adaobi', rating: 4 });
  assert.equal(published.buyerName, 'Adaobi');
});

test('reviews feed the ranking engine instead of the Bayesian prior', () => {
  // This is the Phase 2 to Phase 3 join. Before reviews existed every seller
  // scored on the prior; now a real rating has to move the number.
  const base = {
    isSponsored: false,
    salesCount90d: 20,
    activeProductCount: 10,
    createdAt: new Date('2024-01-01'),
  };
  const now = new Date('2026-10-23T12:00:00.000Z');

  const unrated = rankingService.computeSellerScore({ ...base, ratingAvg: 0, ratingCount: 0 }, now);
  const wellRated = rankingService.computeSellerScore({ ...base, ratingAvg: 4.9, ratingCount: 80 }, now);
  const badlyRated = rankingService.computeSellerScore({ ...base, ratingAvg: 1.8, ratingCount: 80 }, now);

  assert.ok(wellRated.score > unrated.score, 'good reviews must lift a seller above an unrated one');
  assert.ok(badlyRated.score < unrated.score, 'bad reviews must push a seller below an unrated one');
  assert.ok(
    wellRated.components.rating - badlyRated.components.rating > 100,
    'the rating term has to carry real weight once reviews exist'
  );
});
