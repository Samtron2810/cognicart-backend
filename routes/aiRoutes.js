/**
 * AI Sales Agent Routes
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/ai/aiService');
const { optionalAuth } = require('../middleware/authMiddleware');
const { optionalShopper } = require('../middleware/shopperMiddleware');

/**
 * @route   POST /api/ai/chat
 * @desc    Process customer conversation message through AI sales agent
 * @access  Public / Private
 */
router.post('/chat', optionalAuth, optionalShopper, async (req, res, next) => {
  try {
    const sellerId = req.sellerId || req.body.sellerId;
    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'sellerId is required (authenticate as a seller or pass sellerId in the body)',
      });
    }

    // A verified buyer session identifies the counterparty better than a
    // phone number typed into a request body.
    const customerPhone = (req.shopper && req.shopper.phone) || req.body.customerPhone || 'anon_customer';
    const { body, history } = req.body;

    const result = await aiService.chat({
      sellerId,
      customerPhone,
      body,
      history,
      shopperId: req.shopperId || null,
      // Only an authenticated seller querying their OWN tenant may read
      // tenant-wide data through the agent (dashboard / agent test console).
      trusted: Boolean(req.user) && req.sellerId === sellerId,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
