/**
 * WhatsApp Integration Routes
 */

const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { verifyWhatsAppSignature } = require('../middleware/webhookMiddleware');

// Public Meta Webhook endpoints
router.get('/webhook', whatsappController.verifyWebhook);
router.post('/webhook', verifyWhatsAppSignature, whatsappController.handleWebhookPost);

// Incoming simulation endpoint (used by frontend sandbox test harness)
router.post('/incoming', optionalAuth, whatsappController.handleIncoming);

// Protected Seller WhatsApp Management
router.get('/config', protect, whatsappController.getConfig);
router.post('/connect', protect, whatsappController.connect);
router.post('/disconnect', protect, whatsappController.disconnect);
router.post('/send', protect, whatsappController.sendOutbound);
router.get('/messages', protect, whatsappController.getMessages);
router.get('/conversations', protect, whatsappController.getConversations);

module.exports = router;
