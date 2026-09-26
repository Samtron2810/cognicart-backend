/**
 * Seller Analytics Routes
 */

const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/overview', analyticsController.getOverview);
router.get('/trends', analyticsController.getSalesTrends);
router.get('/top-products', analyticsController.getTopProducts);
router.get('/customers', analyticsController.getCustomerAnalytics);

// CSV Data Exports
router.get('/export/orders', analyticsController.exportOrders);
router.get('/export/revenue', analyticsController.exportRevenue);

module.exports = router;
