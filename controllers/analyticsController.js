/**
 * Seller Analytics and Export Controller
 * Exposes endpoints for sales dashboards, trends, top products, and CSV exports
 */

const analyticsService = require('../services/analytics/analyticsService');

const analyticsController = {
  /**
   * @route   GET /api/analytics/overview
   * @desc    Get overall sales, earnings, orders, and customer KPIs
   * @access  Private (Seller)
   */
  async getOverview(req, res, next) {
    try {
      const data = await analyticsService.getOverview(req.sellerId);
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/analytics/trends
   * @desc    Get time-series sales and volume trends
   * @access  Private (Seller)
   */
  async getSalesTrends(req, res, next) {
    try {
      const days = req.query.days ? parseInt(req.query.days, 10) : 14;
      const data = await analyticsService.getSalesTrends(req.sellerId, { days });
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/analytics/top-products
   * @desc    Get top selling products ranked by quantity and revenue
   * @access  Private (Seller)
   */
  async getTopProducts(req, res, next) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 5;
      const data = await analyticsService.getTopProducts(req.sellerId, { limit });
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/analytics/customers
   * @desc    Get customer spending and retention metrics
   * @access  Private (Seller)
   */
  async getCustomerAnalytics(req, res, next) {
    try {
      const data = await analyticsService.getCustomerAnalytics(req.sellerId);
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/analytics/export/orders
   * @desc    Download CSV of seller orders
   * @access  Private (Seller)
   */
  async exportOrders(req, res, next) {
    try {
      const csv = await analyticsService.exportOrdersCSV(req.sellerId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="orders-${req.sellerId}-${Date.now()}.csv"`);
      res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/analytics/export/revenue
   * @desc    Download CSV of revenue and settlement transactions
   * @access  Private (Seller)
   */
  async exportRevenue(req, res, next) {
    try {
      const csv = await analyticsService.exportRevenueCSV(req.sellerId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="revenue-${req.sellerId}-${Date.now()}.csv"`);
      res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = analyticsController;
