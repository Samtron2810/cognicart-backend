/**
 * Product Catalog Routes
 */

const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { protect, optionalAuth, requireVerifiedEmail } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

// Public / Seller Catalog listing
router.get('/', optionalAuth, productController.getProducts);

// Image Upload
router.post('/upload', protect, requireVerifiedEmail, upload.array('images', 5), productController.uploadImages);

// Product CRUD
router.post('/', protect, requireVerifiedEmail, productController.createProduct);
router.get('/:id', optionalAuth, productController.getProductById);
router.patch('/:id', protect, requireVerifiedEmail, productController.updateProduct);
router.delete('/:id', protect, requireVerifiedEmail, productController.deleteProduct);

module.exports = router;
