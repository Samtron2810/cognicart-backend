/**
 * Root and API Overview Routes
 */

const express = require('express');
const router = express.Router();

// Root route
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    name: 'WABAC API',
    description: 'WhatsApp Business AI Commerce Backend Platform',
    version: '1.0.0',
    documentation: '/api',
  });
});

// API Documentation / Directory Route
router.get('/api', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'WABAC REST API is active',
    endpoints: {
      auth: '/api/auth',
      sellers: '/api/sellers',
      business: '/api/business',
      products: '/api/products',
      orders: '/api/orders',
      customers: '/api/customers',
      whatsapp: '/api/whatsapp',
      payments: '/api/payments',
      ai: '/api/ai',
      analytics: '/api/analytics',
      payouts: '/api/payouts',
      campaigns: '/api/campaigns',
      storefront: '/api/storefront',
      admin: '/api/admin',
      platform: '/api/platform',
      health: '/api/health',
    },
  });
});

module.exports = router;
