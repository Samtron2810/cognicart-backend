/**
 * Seller Review Service
 *
 * Who may review: a verified buyer who has a **delivered** order from that
 * seller, once per order. That restriction is the whole feature. Open reviews
 * get gamed on day one — by sellers inflating themselves and by competitors
 * dragging each other down — and a rating nobody can trust is worse than no
 * rating, because the UI presents it as authoritative.
 *
 * Writing a review recomputes the seller's cached rating and immediately
 * re-scores them for the directory, so the ranking engine shipped in Phase 1
 * finally has a real rating signal instead of the Bayesian prior.
 */

const mongoose = require('mongoose');
const Review = require('../../models/Review');
const Order = require('../../models/Order');
const Business = require('../../models/Business');
const Shopper = require('../../models/Shopper');
const rankingService = require('../ranking/rankingService');
const { sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(message = 'Review not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/**
 * Public shape of a review. `shopperId` is stripped by the model transform;
 * this additionally trims the buyer name to a first name plus initial, so a
 * public page never publishes a full customer name.
 */
function toPublicReview(review) {
  const json = typeof review.toJSON === 'function' ? review.toJSON() : { ...review };
  if (json._id) {
    json.id = String(json._id);
    delete json._id;
  }
  delete json.shopperId;
  delete json.__v;

  const parts = String(json.buyerName || 'Verified buyer').trim().split(/\s+/);
  json.buyerName =
    parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];

  json.isVerifiedPurchase = true;
  return json;
}

const reviewService = {
  /**
   * Can this buyer review this seller, and against which orders?
   *
   * Returns the delivered orders that have not been reviewed yet, so the UI
   * can name the purchase being reviewed rather than asking an abstract
   * "rate this store".
   */
  async getEligibility(shopperId, sellerId) {
    if (!shopperId || !sellerId) return { canReview: false, eligibleOrders: [] };

    const delivered = await Order.find({
      shopperId,
      sellerId,
      orderStatus: 'Delivered',
    })
      .select('_id orderNumber createdAt items')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    if (!delivered.length) return { canReview: false, eligibleOrders: [] };

    // Only STORE reviews consume a store-review slot. Without the productId
    // filter, rating one item would silently use up the buyer's right to
    // review the shop for that order.
    const used = await Review.find({
      shopperId,
      productId: null,
      orderId: { $in: delivered.map((order) => String(order._id)) },
    })
      .select('orderId')
      .lean();

    const usedIds = new Set(used.map((review) => String(review.orderId)));

    const eligibleOrders = delivered
      .filter((order) => !usedIds.has(String(order._id)))
      .map((order) => ({
        orderId: String(order._id),
        reference: order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : '',
        createdAt: order.createdAt,
        itemSummary: (order.items || []).map((item) => item.name).slice(0, 3).join(', '),
      }));

    return { canReview: eligibleOrders.length > 0, eligibleOrders };
  },

  /**
   * Can this buyer review this PRODUCT, and against which orders?
   *
   * The rule the UI advertises: you may review a product you actually bought
   * and received. So we look for delivered orders belonging to this buyer
   * that contain this product, minus the ones already used to review it.
   *
   * Returns the same shape as getEligibility so the form can be reused, plus
   * `hasPurchased` to let the page tell "never bought it" apart from
   * "bought it and already reviewed it" — two very different messages.
   */
  async getProductEligibility(shopperId, productId) {
    const empty = { canReview: false, eligibleOrders: [], hasPurchased: false, hasReviewed: false };
    if (!shopperId || !productId) return empty;

    const wanted = String(productId);

    // items.productId is a plain string on the order, so this matches without
    // caring whether the caller passed an ObjectId or its string form.
    const delivered = await Order.find({
      shopperId,
      orderStatus: 'Delivered',
      'items.productId': wanted,
    })
      .select('_id orderNumber createdAt items sellerId')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    if (!delivered.length) return empty;

    const used = await Review.find({
      shopperId,
      productId: wanted,
      orderId: { $in: delivered.map((order) => String(order._id)) },
    })
      .select('orderId')
      .lean();

    const usedIds = new Set(used.map((review) => String(review.orderId)));

    const eligibleOrders = delivered
      .filter((order) => !usedIds.has(String(order._id)))
      .map((order) => {
        const line = (order.items || []).find((item) => String(item.productId || '') === wanted);
        return {
          orderId: String(order._id),
          sellerId: String(order.sellerId),
          reference: order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : '',
          createdAt: order.createdAt,
          itemSummary: (line && line.name) || '',
        };
      });

    return {
      canReview: eligibleOrders.length > 0,
      eligibleOrders,
      hasPurchased: true,
      hasReviewed: usedIds.size > 0,
    };
  },

  /**
   * Create a review.
   *
   * Every gate is re-checked here against the database. The frontend asking
   * nicely is not a security control: the order must exist, belong to this
   * buyer, belong to this seller, and be delivered.
   */
  async create(shopperId, { sellerId, orderId, productId, rating, comment } = {}) {
    if (!shopperId) throw badRequest('A verified buyer session is required to leave a review');
    if (!sellerId) throw badRequest('Seller is required');
    if (!orderId) throw badRequest('Order is required');

    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw badRequest('Rating must be a whole number between 1 and 5');
    }

    if (!mongoose.isValidObjectId(orderId)) throw notFound('Order not found');

    const order = await Order.findById(orderId).lean();
    if (!order) throw notFound('Order not found');

    // Ownership. Checked before anything else is revealed about the order.
    if (String(order.shopperId || '') !== String(shopperId)) {
      logger.warn('Review blocked: order does not belong to this buyer', { orderId, shopperId });
      throw notFound('Order not found');
    }

    if (String(order.sellerId) !== String(sellerId)) {
      throw badRequest('That order was not placed with this store');
    }

    if (order.orderStatus !== 'Delivered') {
      throw badRequest('You can review a store once your order has been delivered');
    }

    // Reviewing one product rather than the store. The order must actually
    // contain it — this is the check that makes "only buyers may review"
    // true at the product level, and it is deliberately done here against
    // the stored order rather than trusting anything the client sent.
    let productKey = null;
    let productName = '';
    if (productId) {
      const line = (order.items || []).find(
        (item) => String(item.productId || '') === String(productId)
      );
      if (!line) {
        throw badRequest('You can only review a product you bought in this order');
      }
      productKey = String(productId);
      productName = line.name || '';
    }

    const business = await Business.findOne({ sellerId }).select('sellerId').lean();
    if (!business) throw notFound('Store not found');

    const shopper = await Shopper.findById(shopperId).select('name').lean();

    try {
      const review = await Review.create({
        sellerId,
        shopperId,
        orderId: String(orderId),
        productId: productKey,
        productName,
        buyerName: (shopper && shopper.name) || order.customerName || 'Verified buyer',
        rating: numericRating,
        comment: sanitize(comment || '', 1000),
      });

      // Cached rating + directory position, updated now rather than at the
      // next hourly pass: the seller should see the effect immediately.
      await this.recomputeSellerRating(sellerId);

      logger.info('Review created:', { sellerId, orderId, rating: numericRating });
      return toPublicReview(review);
    } catch (error) {
      // The unique index is the real guard against double-reviewing.
      if (error && error.code === 11000) {
        throw badRequest(
          productKey
            ? 'You have already reviewed this product for this order'
            : 'You have already reviewed this order'
        );
      }
      throw error;
    }
  },

  /**
   * Published reviews for a store, newest first, with the score breakdown the
   * store page shows next to the average.
   */
  async listForSeller(sellerId, { page = 1, limit = DEFAULT_LIMIT } = {}) {
    // Store pages list everything written about the seller, product reviews
    // included, so the average, the count and the visible list agree.
    return this.listPublished({ sellerId, status: 'published' }, { page, limit });
  },

  /**
   * Published reviews for a single product, with the same summary shape the
   * store page uses so the UI can share one component.
   */
  async listForProduct(productId, { page = 1, limit = DEFAULT_LIMIT } = {}) {
    if (!productId) {
      return {
        reviews: [],
        summary: { average: null, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
        pagination: { total: 0, page: 1, limit: DEFAULT_LIMIT, totalPages: 1, hasMore: false },
      };
    }
    return this.listPublished({ productId: String(productId), status: 'published' }, { page, limit });
  },

  /** Shared pagination + rating breakdown for any published-review filter. */
  async listPublished(filter, { page = 1, limit = DEFAULT_LIMIT } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || DEFAULT_LIMIT));

    const [rows, total, breakdown] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Review.countDocuments(filter),
      Review.aggregate([
        { $match: filter },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]),
    ]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let weighted = 0;
    for (const row of breakdown) {
      distribution[row._id] = row.count;
      weighted += row._id * row.count;
    }

    const totalPages = Math.ceil(total / limitNum) || 1;

    return {
      reviews: rows.map(toPublicReview),
      summary: {
        average: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
        total,
        distribution,
      },
      pagination: { total, page: pageNum, limit: limitNum, totalPages, hasMore: pageNum < totalPages },
    };
  },

  /**
   * Reviews for the seller's own dashboard, including hidden ones so they can
   * see what was moderated and why.
   */
  async listForDashboard(sellerId, { page = 1, limit = 20 } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || 20));

    const [rows, total] = await Promise.all([
      Review.find({ sellerId }).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Review.countDocuments({ sellerId }),
    ]);

    return {
      reviews: rows.map((row) => ({ ...toPublicReview(row), status: row.status })),
      pagination: { total, page: pageNum, limit: limitNum },
    };
  },

  /**
   * A seller's public answer to a review. Scoped by sellerId, so a seller can
   * only ever reply to a review left about their own store.
   */
  async reply(reviewId, sellerId, text) {
    if (!mongoose.isValidObjectId(reviewId)) throw notFound();

    const body = sanitize(text || '', 1000);
    if (!body) throw badRequest('Reply cannot be empty');

    const review = await Review.findOneAndUpdate(
      { _id: reviewId, sellerId },
      { $set: { 'sellerReply.text': body, 'sellerReply.repliedAt': new Date() } },
      { new: true, runValidators: true }
    );

    if (!review) {
      logger.warn('Review reply blocked: not found or cross-tenant', { reviewId, sellerId });
      throw notFound('Review not found or access denied');
    }

    return toPublicReview(review);
  },

  /**
   * Admin moderation. Hiding a review removes it from the public list and
   * from the seller's average, but never deletes it.
   */
  async setStatus(reviewId, status, hiddenReason = '') {
    if (!mongoose.isValidObjectId(reviewId)) throw notFound();
    if (!['published', 'hidden'].includes(status)) throw badRequest('Status must be published or hidden');

    const review = await Review.findByIdAndUpdate(
      reviewId,
      { $set: { status, hiddenReason: status === 'hidden' ? sanitize(hiddenReason, 300) : '' } },
      { new: true }
    );

    if (!review) throw notFound();

    await this.recomputeSellerRating(review.sellerId);
    logger.info('Review moderated:', { reviewId, status });
    return toPublicReview(review);
  },

  /**
   * Recalculate a seller's cached rating from published reviews, then
   * re-score them for the directory.
   *
   * This is the join between Phase 2 and the Phase 1 ranking engine: until
   * now `Business.ratingAvg` was always 0 and the score fell back to the
   * Bayesian prior for everyone.
   */
  async recomputeSellerRating(sellerId) {
    if (!sellerId) return { ratingAvg: 0, ratingCount: 0 };

    const [summary] = await Review.aggregate([
      { $match: { sellerId: String(sellerId), status: 'published' } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);

    const ratingCount = summary ? summary.count : 0;
    const ratingAvg = summary ? Math.round(summary.average * 100) / 100 : 0;

    await Business.updateOne({ sellerId }, { $set: { ratingAvg, ratingCount } });
    await rankingService.refreshSellerRanking(sellerId);

    return { ratingAvg, ratingCount };
  },

  /**
   * Rebuild every seller's cached rating in one pass. Used by the hourly job
   * as a self-heal, so a rating can never drift permanently out of step with
   * the reviews behind it.
   */
  async recomputeAllRatings() {
    const grouped = await Review.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$sellerId', average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);

    const byseller = new Map(
      grouped.map((row) => [String(row._id), { ratingAvg: Math.round(row.average * 100) / 100, ratingCount: row.count }])
    );

    const businesses = await Business.find({}).select('sellerId ratingAvg ratingCount').lean();

    const operations = businesses
      .map((business) => {
        const next = byseller.get(String(business.sellerId)) || { ratingAvg: 0, ratingCount: 0 };
        // Only write rows that actually changed.
        if (next.ratingAvg === (business.ratingAvg || 0) && next.ratingCount === (business.ratingCount || 0)) {
          return null;
        }
        return { updateOne: { filter: { _id: business._id }, update: { $set: next } } };
      })
      .filter(Boolean);

    if (operations.length) await Business.bulkWrite(operations, { ordered: false });

    return { updated: operations.length };
  },

  toPublicReview,
};

module.exports = reviewService;
