/**
 * Seller Review Routes
 *
 * Writing a review needs a verified *buyer* session (protectShopper), while
 * replying needs a *seller* session (protect). The two middlewares are
 * deliberately separate — a buyer token must never populate req.sellerId.
 */

const express = require('express');
const router = express.Router();

const reviewController = require('../controllers/reviewController');
const { protect, requireVerifiedEmail } = require('../middleware/authMiddleware');
const { protectShopper } = require('../middleware/shopperMiddleware');
const { createRateLimiter } = require('../middleware/rateLimiter');

// Reviews are public content tied to money changing hands; throttle writes.
const writeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many reviews submitted from this device. Please try again later.',
});

// --- Verified buyer ---
router.get('/eligibility', protectShopper, reviewController.getEligibility);
router.post('/', protectShopper, writeLimiter, reviewController.create);

// --- Seller ---
router.get('/seller', protect, reviewController.listForDashboard);
router.post('/:id/reply', protect, requireVerifiedEmail, reviewController.reply);

module.exports = router;
