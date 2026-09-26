/**
 * Seller and Business Profile Routes
 */

const express = require('express');
const router = express.Router();
const sellerController = require('../controllers/sellerController');
const { protect } = require('../middleware/authMiddleware');

// Authenticated seller business profile management
router.get('/', protect, sellerController.getBusiness);
router.patch('/', protect, sellerController.updateBusiness);
router.get('/profile', protect, sellerController.getBusiness);

// Public storefront profile endpoints
router.get('/:id', sellerController.getPublicStorefront);
router.get('/:id/storefront', sellerController.getPublicStorefront);

module.exports = router;
