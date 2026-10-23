'use strict';

/**
 * Seller ranking: scoring, fairness and the tie shuffle.
 *
 * These are pure functions, so they are tested directly with no database.
 * The scoring rules are a product decision, so each case pins the intent
 * rather than the arithmetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-ranking-suite-0123456789';

const {
  computeSellerScore,
  shuffleTieGroups,
  bayesianRating,
  newSellerBoost,
  normaliseCount,
  isSponsorshipActive,
  seededRandom,
  WEIGHTS,
  NEW_SELLER_WINDOW_DAYS,
} = require('../services/ranking/rankingService');

const DAY = 24 * 60 * 60 * 1000;

test('normaliseCount saturates instead of letting one huge seller dominate', () => {
  assert.equal(normaliseCount(0, 200), 0);
  assert.ok(normaliseCount(200, 200) > 0.99);

  // The same extra 10 sales must be worth far less to a big seller than to a
  // small one, otherwise the biggest store wins permanently.
  const firstTen = normaliseCount(10, 200) - normaliseCount(0, 200);
  const lastTen = normaliseCount(200, 200) - normaliseCount(190, 200);
  assert.ok(firstTen > lastTen * 10, `${firstTen} should dwarf ${lastTen}`);
});

test('normaliseCount never exceeds 1 even far past saturation', () => {
  assert.ok(normaliseCount(100000, 200) <= 1);
});

test('bayesianRating pulls a thin rating toward the prior', () => {
  // One 5-star review must not outrank a long 4.6-star history.
  const thin = bayesianRating(5, 1);
  const solid = bayesianRating(4.6, 80);
  assert.ok(thin < solid, `expected ${thin} < ${solid}`);
});

test('bayesianRating returns the prior mean when there are no reviews', () => {
  assert.equal(bayesianRating(0, 0), 3.5);
});

test('newSellerBoost decays to zero across the window', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const justJoined = new Date(now.getTime() - 1000);
  const halfway = new Date(now.getTime() - (NEW_SELLER_WINDOW_DAYS / 2) * DAY);
  const expired = new Date(now.getTime() - (NEW_SELLER_WINDOW_DAYS + 1) * DAY);

  assert.ok(newSellerBoost(justJoined, now) > 0.98);
  assert.ok(Math.abs(newSellerBoost(halfway, now) - 0.5) < 0.05);
  assert.equal(newSellerBoost(expired, now), 0);
});

test('a brand-new seller with nothing still outranks a dormant empty store', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const { score: newcomer } = computeSellerScore(
    { createdAt: new Date(now.getTime() - DAY), ratingAvg: 0, ratingCount: 0, activeProductCount: 1, salesCount90d: 0 },
    now,
  );
  const { score: dormant } = computeSellerScore(
    { createdAt: new Date(now.getTime() - 400 * DAY), ratingAvg: 0, ratingCount: 0, activeProductCount: 1, salesCount90d: 0 },
    now,
  );
  assert.ok(newcomer > dormant, 'the new-seller boost is what makes the marketplace joinable');
});

test('sponsorship adds its weight but cannot beat a strong organic seller alone', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const old = new Date(now.getTime() - 400 * DAY);

  const { score: sponsoredEmpty } = computeSellerScore(
    { createdAt: old, isSponsored: true, ratingAvg: 0, ratingCount: 0, activeProductCount: 0, salesCount90d: 0 },
    now,
  );
  const { score: organicStrong } = computeSellerScore(
    { createdAt: old, isSponsored: false, ratingAvg: 4.8, ratingCount: 120, activeProductCount: 150, salesCount90d: 180 },
    now,
  );
  assert.ok(organicStrong > sponsoredEmpty, 'paid placement must not outweigh real performance');
});

test('an expired sponsorship stops counting', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(isSponsorshipActive({ isSponsored: true, sponsoredUntil: new Date(now.getTime() - DAY) }, now), false);
  assert.equal(isSponsorshipActive({ isSponsored: true, sponsoredUntil: new Date(now.getTime() + DAY) }, now), true);
  // No end date means an open-ended sponsorship.
  assert.equal(isSponsorshipActive({ isSponsored: true, sponsoredUntil: null }, now), true);
  assert.equal(isSponsorshipActive({ isSponsored: false, sponsoredUntil: null }, now), false);
});

test('score stays within the sum of all weights', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const ceiling = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
  const { score: best, components } = computeSellerScore(
    { createdAt: now, isSponsored: true, ratingAvg: 5, ratingCount: 10000, activeProductCount: 100000, salesCount90d: 100000 },
    now,
  );
  assert.ok(best <= ceiling + 0.001, `${best} exceeded ceiling ${ceiling}`);
  assert.ok(best > 0);
  // Every weight must be represented, so a missing component is caught here.
  assert.deepEqual(Object.keys(components).sort(), Object.keys(WEIGHTS).sort());
});

test('seededRandom is deterministic for a given seed', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test('shuffleTieGroups keeps ordering by score across tie bands', () => {
  const sellers = [
    { sellerId: 'a', rankingScore: 900 },
    { sellerId: 'b', rankingScore: 500 },
    { sellerId: 'c', rankingScore: 495 },
    { sellerId: 'd', rankingScore: 490 },
    { sellerId: 'e', rankingScore: 100 },
  ];
  const out = shuffleTieGroups(sellers, 12345);

  assert.equal(out.length, 5);
  assert.equal(out[0].sellerId, 'a', 'a clear leader must stay first');
  assert.equal(out[4].sellerId, 'e', 'a clear laggard must stay last');
  // b, c and d are within tolerance of each other and may appear in any order.
  assert.deepEqual(new Set(out.slice(1, 4).map((s) => s.sellerId)), new Set(['b', 'c', 'd']));
});

test('shuffleTieGroups actually rotates near-equal sellers across seeds', () => {
  const sellers = Array.from({ length: 8 }, (_, i) => ({ sellerId: `s${i}`, rankingScore: 500 }));
  const orders = new Set();
  for (let seed = 0; seed < 25; seed += 1) {
    orders.add(shuffleTieGroups(sellers, seed).map((s) => s.sellerId).join(','));
  }
  assert.ok(orders.size > 1, 'tied sellers must not always be shown in the same order');
});

test('shuffleTieGroups is stable within one hour', () => {
  const sellers = Array.from({ length: 6 }, (_, i) => ({ sellerId: `s${i}`, rankingScore: 300 }));
  const first = shuffleTieGroups(sellers, 777).map((s) => s.sellerId);
  const second = shuffleTieGroups(sellers, 777).map((s) => s.sellerId);
  assert.deepEqual(first, second, 'a buyer paging the directory must not see items jump');
});

test('shuffleTieGroups tolerates an empty list', () => {
  assert.deepEqual(shuffleTieGroups([], 1), []);
});
