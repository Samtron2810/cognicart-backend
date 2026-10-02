/**
 * Product Controller
 * Handles product CRUD, image uploads to Cloudinary, and public/private catalog queries
 */

const productService = require('../services/products/productService');

/**
 * @route   GET /api/products
 * @desc    Get products (scoped to seller when authenticated, or public active catalog)
 * @access  Public / Private
 */
async function getProducts(req, res, next) {
  try {
    const isPublic = req.query.public === 'true' || !req.sellerId;
    const sellerId = req.query.sellerId || req.sellerId;
    const { search, category, isActive } = req.query;

    const products = await productService.list({
      sellerId,
      search,
      category,
      isActive,
      isPublic,
    });

    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/products/:id
 * @desc    Get product details by ID
 * @access  Public / Private
 */
async function getProductById(req, res, next) {
  try {
    const isPublic = req.query.public === 'true' || !req.sellerId;
    const product = await productService.getById(req.params.id, req.sellerId, isPublic);
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/products
 * @desc    Create a new product
 * @access  Private
 */
async function createProduct(req, res, next) {
  try {
    const product = await productService.create(req.sellerId, req.body);
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   PATCH /api/products/:id
 * @desc    Update product by ID
 * @access  Private
 */
async function updateProduct(req, res, next) {
  try {
    const product = await productService.update(req.params.id, req.sellerId, req.body);
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   DELETE /api/products/:id
 * @desc    Delete product by ID
 * @access  Private
 */
async function deleteProduct(req, res, next) {
  try {
    const result = await productService.remove(req.params.id, req.sellerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
