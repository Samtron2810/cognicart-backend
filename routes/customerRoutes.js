/**
 * Customer Management Routes
 */

const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const { protect, requireVerifiedEmail } = require('../middleware/authMiddleware');

router.use(protect, requireVerifiedEmail);

router.get('/', customerController.getCustomers);
router.get('/:id', customerController.getCustomerById);
router.post('/', customerController.createCustomer);

module.exports = router;
