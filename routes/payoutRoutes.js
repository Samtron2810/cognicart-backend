/**
 * Seller Payout and Settlement Routes
 */

const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/balance', payoutController.getBalance);
router.post('/resolve-account', payoutController.resolveAccount);
router.post('/request', payoutController.requestPayout);
router.get('/', payoutController.listPayouts);

module.exports = router;
