/** Verify Telegram's per-bot X-Telegram-Bot-Api-Secret-Token header. */

const crypto = require('crypto');
const Business = require('../models/Business');
const logger = require('../utils/logger');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function verifyTelegramWebhook(req, res, next) {
  try {
    const botId = String(req.params.botId || '').trim();
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (!botId || !provided) {
      return res.status(401).json({ success: false, message: 'Invalid Telegram webhook credentials' });
    }

    const business = await Business.findOne({
      telegramBotId: botId,
      telegramConnected: true,
    }).select('+telegramBotToken +telegramWebhookSecret');

    if (!business || !safeEqual(provided, business.telegramWebhookSecret)) {
      logger.warn('Telegram webhook rejected:', { botId, reason: 'credential_mismatch' });
      return res.status(401).json({ success: false, message: 'Invalid Telegram webhook credentials' });
    }

    req.telegramBusiness = business;
    req.sellerId = business.sellerId;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { verifyTelegramWebhook, safeEqual };
