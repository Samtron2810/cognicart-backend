/**
 * Product Catalog Routes
 */

const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { protect, optionalAuth, requireVerifiedEmail } = require('../middleware/authMiddleware');

// Public / Seller Catalog listing
router.get('/', optionalAuth, productController.getProducts);

// Image uploads no longer pass through this API: the browser uploads directly
// to Cloudinary with a signed ticket from POST /api/uploads/signature.

// Product CRUD
router.post('/', protect, requireVerifiedEmail, productController.createProduct);
router.get('/:id', optionalAuth, productController.getProductById);
router.patch('/:id', protect, requireVerifiedEmail, productController.updateProduct);
router.delete('/:id', protect, requireVerifiedEmail, productController.deleteProduct);

module.exports = router;
