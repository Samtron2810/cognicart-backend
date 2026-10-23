/**
 * Public Seller Directory Routes
 *
 * Mounted at /api/stores (plural). The singular /api/store and
 * /api/storefront remain the per-store catalog API — this is the list of
 * stores that sits in front of them.
 */

const express = require('express');
const router = express.Router();
const storeDirectoryController = require('../controllers/storeDirectoryController');

// Static segments first so they are not swallowed by a future /:identifier.
router.get('/promoted-products', storeDirectoryController.listPromotedProducts);
router.get('/others', storeDirectoryController.listOtherStores);
router.get('/', storeDirectoryController.listStores);

module.exports = router;
