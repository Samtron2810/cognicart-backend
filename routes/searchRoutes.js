/**
 * Global Search Routes
 * One public endpoint returning both sellers and products for the header
 * type-ahead and the full search page.
 */

const express = require('express');
const router = express.Router();
const searchService = require('../services/search/searchService');

/**
 * @route   GET /api/search?q=&sellerLimit=&productLimit=
 * @desc    Sellers and products matching one query
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await searchService.search(req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
