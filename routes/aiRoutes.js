/**
 * AI Sales Agent Routes
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/ai/aiService');
const { optionalAuth } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/ai/chat
 * @desc    Process customer conversation message through AI sales agent
 * @access  Public / Private
 */
router.post('/chat', optionalAuth, async (req, res, next) => {
  try {
    const sellerId = req.sellerId || req.body.sellerId || 'seller_admin';
    const customerPhone = req.body.customerPhone || 'anon_customer';
    const { body, history } = req.body;

    const result = await aiService.chat({
      sellerId,
      customerPhone,
      body,
      history,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
