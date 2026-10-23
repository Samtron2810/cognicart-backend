/**
 * Public Seller Directory Controller
 * Serves the seller-first storefront: a list of stores, and the small
 * promoted-products strip that sits above it.
 */

const storeDirectoryService = require('../services/stores/storeDirectoryService');

const storeDirectoryController = {
  /**
   * @route   GET /api/stores
   * @desc    Paginated public list of sellers, ranked
   * @access  Public
   */
  async listStores(req, res, next) {
    try {
      const result = await storeDirectoryService.listStores(req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/stores/promoted-products
   * @desc    Up to 8 promoted products across sellers, for the strip
   * @access  Public
   */
  async listPromotedProducts(req, res, next) {
    try {
      const result = await storeDirectoryService.listPromotedProducts({ limit: req.query.limit });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/stores/others
   * @desc    Quick-jump bar shown inside a store page
   * @access  Public
   */
  async listOtherStores(req, res, next) {
    try {
      const result = await storeDirectoryService.listOtherStores(req.query.exclude || '', req.query.limit);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = storeDirectoryController;
