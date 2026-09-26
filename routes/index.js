/**
 * Master Route Aggregator
 * Centralizes and mounts all modular sub-routes
 */

const express = require('express');
const router = express.Router();

const rootRoutes = require('./rootRoutes');
const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');
const sellerRoutes = require('./sellerRoutes');
const productRoutes = require('./productRoutes');
const orderRoutes = require('./orderRoutes');
const customerRoutes = require('./customerRoutes');
const whatsappRoutes = require('./whatsappRoutes');
const whatsappWebhook = require('../webhooks/whatsappWebhook');
const paymentRoutes = require('./paymentRoutes');
const platformRoutes = require('./platformRoutes');
const aiRoutes = require('./aiRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const payoutRoutes = require('./payoutRoutes');
const campaignRoutes = require('./campaignRoutes');
const storefrontRoutes = require('./storefrontRoutes');

// Root & System Health
router.use('/', rootRoutes);
router.use('/health', healthRoutes);
router.use('/api/health', healthRoutes);

// Feature APIs
router.use('/api/auth', authRoutes);
router.use('/api/sellers', sellerRoutes);
router.use('/api/business', sellerRoutes); // Direct mount for businessService compatibility
router.use('/api/products', productRoutes);
router.use('/api/orders', orderRoutes);
router.use('/api/customers', customerRoutes);
router.use('/api/whatsapp', whatsappRoutes);
router.use('/webhooks/whatsapp', whatsappWebhook);
router.use('/api/webhooks/whatsapp', whatsappWebhook);
router.use('/api/payments', paymentRoutes);
router.use('/api/ai', aiRoutes);
router.use('/api/analytics', analyticsRoutes);
router.use('/api/payouts', payoutRoutes);
router.use('/api/campaigns', campaignRoutes);
router.use('/api/storefront', storefrontRoutes);
router.use('/api/store', storefrontRoutes);
router.use('/api/admin', platformRoutes);
router.use('/api/platform', platformRoutes);

module.exports = router;
