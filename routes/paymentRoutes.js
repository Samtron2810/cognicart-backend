/**
 * Payment and Checkout Routes
 */

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { verifyPaystackSignature } = require('../middleware/webhookMiddleware');

// Payment Checkout Initialization
router.post('/initialize', optionalAuth, paymentController.initializePayment);

// Paystack redirects the buyer here; the backend verifies before returning to UI.
router.get('/callback', paymentController.paymentCallback);

// Transaction verification always calls Paystack; local references are never trusted.
router.post('/verify/:reference', paymentController.verifyPayment);
router.get('/verify/:reference', paymentController.verifyPayment);

// Webhook listener — primary path registered in Paystack dashboard.
router.post('/webhook', verifyPaystackSignature, paymentController.handlePaystackWebhook);

// Transaction inspection
router.get('/:reference', optionalAuth, paymentController.getPaymentByReference);
router.get('/', protect, paymentController.listTransactions);

module.exports = router;
