/**
 * Public Storefront and Discoverability Routes
 * All endpoints are publicly accessible to empower online storefronts and search engine indexing
 */

const express = require('express');
const router = express.Router();
const storefrontController = require('../controllers/storefrontController');
const reviewController = require('../controllers/reviewController');
const { attachVisitor } = require('../middleware/visitorMiddleware');
const { optionalShopper } = require('../middleware/shopperMiddleware');

// Store details & discovery
router.get('/:identifier', storefrontController.getStore);
router.get('/:identifier/categories', storefrontController.getCategories);

// Catalog search & filtering
router.get('/:identifier/products', storefrontController.getProducts);
router.get('/:identifier/products/:productId', storefrontController.getProduct);

// SEO, OpenGraph & Structured Data
router.get('/:identifier/seo', storefrontController.getStoreSEO);
router.get('/:identifier/products/:productId/seo', storefrontController.getProductSEO);

// Sitemaps
router.get('/:identifier/sitemap.xml', storefrontController.getSitemapXml);
router.get('/:identifier/sitemap.json', storefrontController.getSitemapJson);
router.get('/:identifier/sitemap', storefrontController.getSitemapJson);

// Buyer reviews of this store
router.get('/:identifier/reviews', reviewController.listPublic);


module.exports = router;
