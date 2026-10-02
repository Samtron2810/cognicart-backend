/**
 * Platform Administration and Revenue Routes
 * Enforces a confirmed email plus role-based access for 'admin' and 'platform_owner'
 */

const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, authorizeRoles, requireVerifiedEmail } = require('../middleware/authMiddleware');

// Secure all admin routes with authentication, confirmed email, and role
// authorization. Verification is checked before the role check so an
// unverified privileged account cannot touch a single admin endpoint - the
// CLI provisions these accounts with `isEmailVerified: true`, and one that
// predates that change must be backfilled with `--promote`.
router.use(protect);
router.use(requireVerifiedEmail);
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
router.get('/telegram', adminController.getTelegramStats);
router.get('/fee', adminController.getFeeConfig);
router.patch('/fee', adminController.updateFeeConfig);

module.exports = router;
