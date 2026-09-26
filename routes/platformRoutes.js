/**
 * Platform Administration and Revenue Routes
 * Enforces role-based access for 'admin' and 'platform_owner'
 */

const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// Secure all admin routes with authentication and role authorization
router.use(protect);
router.use(authorizeRoles('admin', 'platform_owner'));

// Operational analytics & KPIs
router.get('/stats', adminController.getPlatformStats);

// Seller management
router.get('/sellers', adminController.listSellers);
router.get('/sellers/:id', adminController.getSellerDetails);
router.patch('/sellers/:id/status', adminController.toggleSellerActive);
router.patch('/sellers/:id/toggle-active', adminController.toggleSellerActive);

// Global records
router.get('/orders', adminController.listAllOrders);
router.get('/customers', adminController.listAllCustomers);

// Financial reports & Commission configuration
router.get('/revenue', adminController.getRevenueBreakdown);
router.get('/payouts', adminController.listPayouts);
router.patch('/payouts/:id/process', adminController.processPayout);
router.get('/whatsapp', adminController.getWhatsAppStats);
router.get('/fee', adminController.getFeeConfig);
router.patch('/fee', adminController.updateFeeConfig);

module.exports = router;
