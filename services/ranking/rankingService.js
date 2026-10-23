/**
 * Seller Ranking Service
 *
 * Decides the order sellers appear in on the public directory.
 *
 * Design notes, because the obvious implementation is wrong:
 *
 * 1. The inputs are in wildly different units — sales count (0..n thousand),
 *    rating (0..5), product count (0..n hundred). Adding them raw means sales
 *    count alone decides the ranking and the rating contributes rounding
 *    error. Every component is therefore normalised to 0..1 and multiplied by
 *    an explicit weight, so the weights are the only thing that decides
 *    importance and they can be read off at a glance.
 *
 * 2. Sales uses a rolling 90-day window. Lifetime sales make an established
 *    seller permanently unbeatable; a new seller would have no reachable path
 *    to the first page, which defeats the point of the new-seller boost.
 *
 * 3. Rating is Bayesian-smoothed towards the platform mean. Without that, one
 *    5.0 from a single review outranks a seller sitting on 4.8 from two
 *    hundred, which is both unfair and trivially gamed.
 *
 * 4. Counts are compressed logarithmically. The difference between 0 and 50
 *    sales says far more about a store than the difference between 950 and
 *    1000, and a linear scale would make the top seller's score drown
 *    everyone else's.
 *
 * Scores are persisted on the Business document, so serving the directory is
 * an indexed sort rather than a computation. That is what satisfies the
 * "cache the ranking" requirement, with no cache layer to deploy or go stale.
 */

const Business = require('../../models/Business');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const JobLock = require('../../models/JobLock');
const logger = require('../../utils/logger');

/**
 * Weights are points out of a nominal 1150. Tune these; nothing else.
 * Sponsored is the single largest term on purpose: it is a paid placement and
 * it is meant to win. It does not win *silently* — the UI labels it.
 */
const WEIGHTS = {
  sponsored: 400,
  sales: 250,
  rating: 200,
  products: 100,
  newSeller: 200,
};

/** Saturation points for the log scales: where a component reaches ~1.0. */
const SALES_SATURATION = 200; // 200 paid orders in 90 days is an excellent store
const PRODUCT_SATURATION = 60; // 60 live products is a well-stocked catalog

/** Bayesian prior: how many "average" reviews a new seller is assumed to hold. */
const RATING_PRIOR_COUNT = 5;
const RATING_PRIOR_MEAN = 3.5;

/** New sellers float for this long after registering. */
const NEW_SELLER_WINDOW_DAYS = 14;

const SALES_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compress an unbounded count into 0..1 with diminishing returns.
 * log1p keeps 0 at exactly 0 and never divides by zero.
 */
function normaliseCount(value, saturation) {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  const scaled = Math.log1p(safe) / Math.log1p(saturation);
  return Math.min(1, Math.max(0, scaled));
}

/**
 * Bayesian average rating, returned on the original 0..5 scale.
 * A seller with no reviews lands exactly on the prior instead of on zero,
 * so "no reviews yet" is not punished as if it were "rated badly".
 */
function bayesianRating(ratingAvg, ratingCount, priorMean = RATING_PRIOR_MEAN, priorCount = RATING_PRIOR_COUNT) {
  const count = Number.isFinite(ratingCount) && ratingCount > 0 ? ratingCount : 0;
  const avg = Number.isFinite(ratingAvg) && ratingAvg > 0 ? Math.min(5, ratingAvg) : 0;
  return (priorCount * priorMean + count * avg) / (priorCount + count);
}

/**
 * Linear decay from 1 to 0 across the new-seller window.
 * A store registered today scores 1; on day 14 it scores 0. The decay is
 * gradual so a seller does not fall off a cliff overnight.
 */
function newSellerBoost(createdAt, now = new Date(), windowDays = NEW_SELLER_WINDOW_DAYS) {
  if (!createdAt) return 0;
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1; // clock skew: treat as brand new
  const windowMs = windowDays * DAY_MS;
  if (ageMs >= windowMs) return 0;
  return 1 - ageMs / windowMs;
}

/**
 * Is a sponsorship currently in force?
 * An expiry in the past means no, regardless of the boolean.
 */
function isSponsorshipActive(business, now = new Date()) {
  if (!business || !business.isSponsored) return false;
  if (!business.sponsoredUntil) return true; // open-ended sponsorship
  return new Date(business.sponsoredUntil).getTime() > now.getTime();
}

/**
 * Score one seller. Pure: no database, no clock of its own.
 *
 * @param {object} stats
 * @param {boolean} stats.isSponsored     Sponsorship already checked for expiry
 * @param {number}  stats.salesCount90d   Paid orders in the rolling window
 * @param {number}  stats.ratingAvg       Mean rating 0..5 (0 when unrated)
 * @param {number}  stats.ratingCount     Number of ratings
 * @param {number}  stats.activeProductCount
 * @param {Date|string} stats.createdAt   Seller registration date
 * @param {Date}    [now]
 * @returns {{ score: number, components: object }}
 */
function computeSellerScore(stats = {}, now = new Date()) {
  const sponsored = stats.isSponsored ? 1 : 0;
  const sales = normaliseCount(stats.salesCount90d, SALES_SATURATION);

  // Map the smoothed 0..5 rating onto 0..1, then scale by how much evidence
  // there actually is. Without this an unreviewed store banks the full prior
  // (3.5/5 = 70% of the rating weight) for free, which — stacked on a paid
  // boost — let an empty sponsored store outrank a genuinely good one.
  // Confidence rises as reviews accumulate and the prior keeps doing its job
  // of stopping a single 5-star review from beating a long record.
  const ratingCount = Number.isFinite(stats.ratingCount) && stats.ratingCount > 0 ? stats.ratingCount : 0;
  const confidence = ratingCount / (ratingCount + RATING_PRIOR_COUNT);
  const rating = (bayesianRating(stats.ratingAvg, stats.ratingCount) / 5) * confidence;
  const products = normaliseCount(stats.activeProductCount, PRODUCT_SATURATION);
  const fresh = newSellerBoost(stats.createdAt, now);

  const components = {
    sponsored: WEIGHTS.sponsored * sponsored,
    sales: WEIGHTS.sales * sales,
    rating: WEIGHTS.rating * rating,
    products: WEIGHTS.products * products,
    newSeller: WEIGHTS.newSeller * fresh,
  };

  const score = Object.values(components).reduce((sum, value) => sum + value, 0);

  // Two decimals is plenty of resolution and keeps the stored value readable.
  return { score: Math.round(score * 100) / 100, components };
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Needed because the shuffle has to
 * be reproducible for a given seed — see shuffleTieGroups.
 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed that rotates once an hour.
 *
 * The requirement was "randomly shuffle sellers with similar scores". Shuffling
 * per request would break pagination outright: a seller could appear on page 1
 * and again on page 2 while another never appeared at all, because each page is
 * a separate request with a separate shuffle. Seeding from the current hour
 * gives a shuffle that is stable for everyone browsing right now — pagination
 * stays coherent — and still rotates, so exposure is shared over the day.
 */
function currentShuffleSeed(now = new Date()) {
  return Math.floor(now.getTime() / (60 * 60 * 1000));
}

/**
 * Shuffle sellers whose scores are close enough to be a tie, leaving the
 * overall ranking intact.
 *
 * Sellers are walked in score order and grouped while each is within
 * `tolerance` of the group's first member. Each group is then shuffled with
 * the shared seed. A clearly better seller never drops below a worse one;
 * only genuine near-ties trade places.
 *
 * @param {Array<{rankingScore:number}>} sellers Sorted by score, descending
 * @param {number} seed
 * @param {number} tolerance Points within which two sellers count as tied
 */
function shuffleTieGroups(sellers = [], seed = 0, tolerance = 25) {
  const random = seededRandom(seed || 1);
  const output = [];
  let group = [];
  let groupAnchor = null;

  const flush = () => {
    // Fisher-Yates with the seeded generator
    for (let i = group.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    output.push(...group);
    group = [];
  };

  for (const seller of sellers) {
    const score = Number(seller.rankingScore) || 0;
    if (groupAnchor === null || groupAnchor - score <= tolerance) {
      if (groupAnchor === null) groupAnchor = score;
      group.push(seller);
    } else {
      flush();
      groupAnchor = score;
      group.push(seller);
    }
  }
  if (group.length) flush();

  return output;
}

/**
 * Gather the live counters every listed seller is scored on.
 * Two aggregations, not one query per seller — the directory has to stay cheap
 * as the seller count grows.
 *
 * @returns {Promise<Map<string, {activeProductCount:number, salesCount90d:number}>>}
 */
async function collectSellerStats(now = new Date()) {
  const since = new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS);

  const [productCounts, salesCounts] = await Promise.all([
    Product.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$sellerId', count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      // Paid only. A pending or cancelled order is not evidence of anything,
      // and counting it would let a seller inflate rank with fake checkouts.
      { $match: { paymentStatus: 'Paid', createdAt: { $gte: since } } },
      { $group: { _id: '$sellerId', count: { $sum: 1 } } },
    ]),
  ]);

  const stats = new Map();
  const ensure = (sellerId) => {
    if (!stats.has(sellerId)) stats.set(sellerId, { activeProductCount: 0, salesCount90d: 0 });
    return stats.get(sellerId);
  };

  for (const row of productCounts) ensure(String(row._id)).activeProductCount = row.count;
  for (const row of salesCounts) ensure(String(row._id)).salesCount90d = row.count;

  return stats;
}

/**
 * Recompute and persist every seller's ranking score.
 *
 * Idempotent and safe to run at any time. One bulkWrite for the whole
 * platform, so the cost is a single round trip regardless of seller count.
 *
 * @returns {Promise<{updated:number, durationMs:number}>}
 */
async function recomputeAllSellerScores(now = new Date()) {
  const startedAt = Date.now();

  // Rebuild every seller's cached rating from the reviews behind it first,
  // so a drifted counter cannot permanently skew the score. Required lazily
  // to avoid a ranking <-> reviews require cycle.
  try {
    // eslint-disable-next-line global-require
    const reviewService = require('../reviews/reviewService');
    await reviewService.recomputeAllRatings();
  } catch (error) {
    // A rating rebuild failure must not stop the ranking job: stale ratings
    // are far better than a directory that stops updating entirely.
    logger.warn('Could not rebuild seller ratings before ranking', { error: error.message });
  }

  const [businesses, stats] = await Promise.all([
    Business.find({})
      .select('sellerId isSponsored sponsoredUntil ratingAvg ratingCount createdAt')
      .lean(),
    collectSellerStats(now),
  ]);

  const operations = businesses.map((business) => {
    const live = stats.get(String(business.sellerId)) || { activeProductCount: 0, salesCount90d: 0 };
    const sponsored = isSponsorshipActive(business, now);

    const { score } = computeSellerScore(
      {
        isSponsored: sponsored,
        salesCount90d: live.salesCount90d,
        ratingAvg: business.ratingAvg,
        ratingCount: business.ratingCount,
        activeProductCount: live.activeProductCount,
        createdAt: business.createdAt,
      },
      now
    );

    return {
      updateOne: {
        filter: { _id: business._id },
        update: {
          $set: {
            activeProductCount: live.activeProductCount,
            salesCount90d: live.salesCount90d,
            rankingScore: score,
            rankedAt: now,
            // Clear a lapsed sponsorship so the flag matches reality instead
            // of quietly staying true forever.
            ...(business.isSponsored && !sponsored ? { isSponsored: false } : {}),
          },
        },
      },
    };
  });

  if (operations.length) {
    await Business.bulkWrite(operations, { ordered: false });
  }

  const durationMs = Date.now() - startedAt;
  logger.info('Seller ranking recomputed', { sellers: operations.length, durationMs });
  return { updated: operations.length, durationMs };
}

/**
 * Recompute the counters and score for a single seller, immediately.
 *
 * The hourly job is the safety net, not the only path. Without this, a seller
 * who publishes their first product stays invisible in the directory for up to
 * an hour — which, on a freshly deployed platform, reads as "the feature is
 * broken". Called after catalog writes and on profile creation.
 *
 * Never throws: a counter is derived data, and failing to refresh it must not
 * fail the product save that triggered it.
 *
 * @param {string} sellerId
 * @returns {Promise<{updated:boolean, score?:number}>}
 */
async function refreshSellerRanking(sellerId, now = new Date()) {
  if (!sellerId) return { updated: false };

  try {
    const business = await Business.findOne({ sellerId })
      .select('sellerId isSponsored sponsoredUntil ratingAvg ratingCount createdAt')
      .lean();
    if (!business) return { updated: false };

    const since = new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS);
    const [activeProductCount, salesCount90d] = await Promise.all([
      Product.countDocuments({ sellerId, isActive: true }),
      Order.countDocuments({ sellerId, paymentStatus: 'Paid', createdAt: { $gte: since } }),
    ]);

    const { score } = computeSellerScore(
      {
        isSponsored: isSponsorshipActive(business, now),
        salesCount90d,
        ratingAvg: business.ratingAvg,
        ratingCount: business.ratingCount,
        activeProductCount,
        createdAt: business.createdAt,
      },
      now
    );

    await Business.updateOne(
      { sellerId },
      { $set: { activeProductCount, salesCount90d, rankingScore: score, rankedAt: now } }
    );

    return { updated: true, score };
  } catch (error) {
    logger.warn('Could not refresh seller ranking', { sellerId, error: error.message });
    return { updated: false };
  }
}

/**
 * Run `recomputeAllSellerScores` behind a distributed lock.
 *
 * On a single instance the lock is a no-op cost. On two or more it is what
 * stops the job running twice at the same minute. A crashed holder does not
 * block anything: the lease expires and the next tick takes over.
 *
 * @param {object} [options]
 * @param {number} [options.leaseMs] How long the claim is held
 * @param {string} [options.owner]   Identity of this worker
 * @returns {Promise<{ran:boolean, reason?:string, updated?:number}>}
 */
async function recomputeWithLock({ leaseMs = 5 * 60 * 1000, owner = `${process.pid}` } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  // Claim only if the lock is free or its lease has lapsed. upsert makes the
  // very first run create the row. The unique index on `key` is what makes
  // two simultaneous claims impossible: the loser gets a duplicate-key error.
  let claimed = null;
  try {
    claimed = await JobLock.findOneAndUpdate(
      { key: 'seller_ranking', $or: [{ expiresAt: { $lte: now } }, { expiresAt: null }] },
      { $set: { owner, lockedAt: now, expiresAt } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error && error.code === 11000) {
      return { ran: false, reason: 'locked' };
    }
    throw error;
  }

  if (!claimed) return { ran: false, reason: 'locked' };

  try {
    const result = await recomputeAllSellerScores(new Date());
    await JobLock.updateOne(
      { key: 'seller_ranking', owner },
      {
        $set: {
          expiresAt: new Date(),
          lastFinishedAt: new Date(),
          lastDurationMs: result.durationMs,
          lastError: '',
        },
      }
    );
    return { ran: true, updated: result.updated };
  } catch (error) {
    await JobLock.updateOne(
      { key: 'seller_ranking', owner },
      { $set: { expiresAt: new Date(), lastError: String(error.message).slice(0, 300) } }
    ).catch(() => {});
    throw error;
  }
}

module.exports = {
  computeSellerScore,
  recomputeAllSellerScores,
  recomputeWithLock,
  refreshSellerRanking,
  collectSellerStats,
  shuffleTieGroups,
  currentShuffleSeed,
  seededRandom,
  bayesianRating,
  newSellerBoost,
  normaliseCount,
  isSponsorshipActive,
  WEIGHTS,
  NEW_SELLER_WINDOW_DAYS,
  SALES_WINDOW_DAYS,
};
