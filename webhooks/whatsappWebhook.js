/**
 * Dedicated WhatsApp Webhook Route Handler
 */

const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const { verifyWhatsAppSignature } = require('../middleware/webhookMiddleware');

router.get('/', whatsappController.verifyWebhook);
router.post('/', verifyWhatsAppSignature, whatsappController.handleWebhookPost);

module.exports = router;
