/**
 * Buyer (Shopper) Routes
 *
 * Progressive identity endpoints. Nothing here requires a password or a signup
 * form: a buyer becomes verified through a Brevo email magic link or one-time
 * code, and only then can read their own data.
 */

const express = require('express');
const router = express.Router();

const shopController = require('../controllers/shopController');
const { protectShopper } = require('../middleware/shopperMiddleware');
const { createRateLimiter } = require('../middleware/rateLimiter');

// Code requests are the expensive, abusable path: throttle hard per IP.
// A per-phone+email cooldown is enforced inside shopperAuthService as well.
const otpRequestLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many verification code requests from this device. Please try again later.',
});

const verifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many verification attempts. Please try again in a few minutes.',
});

// --- Authentication (public) ---
router.post('/auth/request-otp', otpRequestLimiter, shopController.requestOtp);
router.post('/auth/verify-otp', verifyLimiter, shopController.verifyOtp);
router.post('/auth/magic', verifyLimiter, shopController.consumeMagicLink);
router.post('/auth/logout', shopController.logout);

// --- Verified buyer only ---
router.get('/me', protectShopper, shopController.getMe);
router.patch('/me', protectShopper, shopController.updateMe);
router.get('/me/orders', protectShopper, shopController.getMyOrders);
router.get('/me/orders/:id', protectShopper, shopController.getMyOrderById);

module.exports = router;
