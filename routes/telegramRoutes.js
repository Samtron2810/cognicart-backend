const express = require('express');
const telegramController = require('../controllers/telegramController');
const { protect } = require('../middleware/authMiddleware');
const { apiLimiter, createRateLimiter } = require('../middleware/rateLimiter');
const { verifyTelegramWebhook } = require('../middleware/telegramWebhookMiddleware');

const router = express.Router();
const webhookLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => `${req.params.botId}:${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'}`,
});

// Telegram calls this route directly. Per-bot secret verification occurs before
// update handling, and provider message ids absorb retries.
router.post(
  '/webhooks/telegram/:botId',
  webhookLimiter,
  verifyTelegramWebhook,
  telegramController.webhook
);

router.use('/telegram', protect, apiLimiter);
router.get('/telegram/config', telegramController.getConfig);
router.post('/telegram/connect', telegramController.connect);
router.delete('/telegram/disconnect', telegramController.disconnect);
router.get('/telegram/messages', telegramController.listMessages);
router.get('/telegram/conversations', telegramController.listConversations);
router.post('/telegram/simulate', telegramController.simulate);

module.exports = router;
