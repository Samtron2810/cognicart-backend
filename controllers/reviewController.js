/**
 * Seller Review Controller
 * Buyer-written store reviews, seller replies, and admin moderation.
 */

const reviewService = require('../services/reviews/reviewService');
const storefrontService = require('../services/storefront/storefrontService');

const reviewController = {
  /**
   * @route   GET /api/storefront/:identifier/reviews
   * @desc    Published reviews for a store, with the score breakdown
   * @access  Public
   */
  async listPublic(req, res, next) {
    try {
      // Resolve slug or sellerId the same way every other storefront route does.
      const store = await storefrontService.resolveStore(req.params.identifier);
      const result = await reviewService.listForSeller(store.sellerId, req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/products/:productId/reviews
   * @desc    Published reviews for one product, with the score breakdown
   * @access  Public
   */
  async listForProduct(req, res, next) {
    try {
      const result = await reviewService.listForProduct(req.params.productId || req.params.id, req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/reviews/eligibility?sellerId=  |  ?productId=
   * @desc    Which of this buyer's delivered orders can still be reviewed
   * @access  Private (verified buyer)
   *
   * productId wins when both are sent: a product question deserves the
   * product answer, which also reports whether they bought it at all.
   */
  async getEligibility(req, res, next) {
    try {
      const result = req.query.productId
        ? await reviewService.getProductEligibility(req.shopperId, req.query.productId)
        : await reviewService.getEligibility(req.shopperId, req.query.sellerId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/reviews
   * @desc    Leave a review for a delivered order
   * @access  Private (verified buyer)
   */
  async create(req, res, next) {
    try {
      const review = await reviewService.create(req.shopperId, req.body);
      res.status(201).json(review);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/reviews/seller
   * @desc    The signed-in seller's own reviews, including hidden ones
   * @access  Private (seller)
   */
  async listForDashboard(req, res, next) {
    try {
      const result = await reviewService.listForDashboard(req.sellerId, req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/reviews/:id/reply
   * @desc    Seller's public answer to a review about their store
   * @access  Private (seller)
   */
  async reply(req, res, next) {
    try {
      const review = await reviewService.reply(req.params.id, req.sellerId, req.body.text);
      res.status(200).json(review);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   PATCH /api/admin/reviews/:id/status
   * @desc    Publish or hide a review
   * @access  Private (Admin / Platform Owner)
   */
  async setStatus(req, res, next) {
    try {
      const review = await reviewService.setStatus(req.params.id, req.body.status, req.body.hiddenReason);
      res.status(200).json(review);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = reviewController;
