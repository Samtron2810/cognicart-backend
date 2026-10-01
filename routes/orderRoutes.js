/**
 * Order Processing and Checkout Routes
 */

const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { optionalShopper } = require('../middleware/shopperMiddleware');
const { authLimiter } = require('../middleware/rateLimiter');

// Order checkout can be performed by authenticated seller or customer checkout (optionalAuth)
router.post('/', optionalAuth, optionalShopper, orderController.createOrder);

// Guest buyer order cancel: verifies ownership by matching email+orderNumber before cancelling.
// No auth token required — works for buyers who never verified their email.
// Rate limited like auth endpoints since it's an email/reference-guessing surface.
router.post('/cancel-guest', authLimiter, orderController.cancelGuestOrder);

// Protected seller order management. Static/manual routes must precede /:id.
router.get('/', protect, orderController.getOrders);
router.get('/summary', protect, orderController.getOrderSummary);
router.post('/manual', protect, orderController.createManualOrder);
router.patch('/manual/:id', protect, orderController.updateManualOrder);
router.patch('/manual/:id/payment', protect, orderController.updateManualOrderPayment);
router.get('/:id/share', protect, orderController.getOrderShare);
router.get('/:id', protect, orderController.getOrderById);
router.patch('/:id', protect, orderController.updateOrderStatus);
router.patch('/:id/status', protect, orderController.updateOrderStatus);

module.exports = router;
