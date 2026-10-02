/**
 * Master Route Aggregator
 * Centralizes and mounts all modular sub-routes
 */

const express = require('express');
const router = express.Router();

const { requireDatabase } = require('../middleware/databaseMiddleware');

const rootRoutes = require('./rootRoutes');
const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');
const sellerRoutes = require('./sellerRoutes');
const productRoutes = require('./productRoutes');
const orderRoutes = require('./orderRoutes');
const customerRoutes = require('./customerRoutes');
const paymentRoutes = require('./paymentRoutes');
const platformRoutes = require('./platformRoutes');
const aiRoutes = require('./aiRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const payoutRoutes = require('./payoutRoutes');
const campaignRoutes = require('./campaignRoutes');
const storefrontRoutes = require('./storefrontRoutes');
const shopRoutes = require('./shopRoutes');
const telegramRoutes = require('./telegramRoutes');
const uploadRoutes = require('./uploadRoutes');
const { verifyPaystackSignature } = require('../middleware/webhookMiddleware');
const paymentController = require('../controllers/paymentController');

// Root & System Health
router.use('/', rootRoutes);
router.use('/health', healthRoutes);
router.use('/api/health', healthRoutes);

// Every feature API below is database backed: reject requests with HTTP 503
// when MongoDB is unreachable (health & root routes stay available).
router.use(['/api', '/webhooks'], requireDatabase);

// Feature APIs
router.use('/', telegramRoutes);

// Paystack webhook alias — some integrations send to /webhooks/paystack instead of /api/payments/webhook.
// rawBody capture in server.js also guards this path.
router.post('/webhooks/paystack', verifyPaystackSignature, paymentController.handlePaystackWebhook);
router.use('/api/auth', authRoutes);
router.use('/api/sellers', sellerRoutes);
router.use('/api/business', sellerRoutes); // Direct mount for businessService compatibility
router.use('/api/uploads', uploadRoutes);
router.use('/api/products', productRoutes);
router.use('/api/orders', orderRoutes);
router.use('/api/customers', customerRoutes);
router.use('/api/payments', paymentRoutes);
router.use('/api/ai', aiRoutes);
router.use('/api/analytics', analyticsRoutes);
router.use('/api/payouts', payoutRoutes);
router.use('/api/campaigns', campaignRoutes);
router.use('/api/shop', shopRoutes);
router.use('/api/storefront', storefrontRoutes);
router.use('/api/store', storefrontRoutes);
router.use('/api/admin', platformRoutes);
router.use('/api/platform', platformRoutes);

module.exports = router;
