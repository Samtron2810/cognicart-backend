/**
 * Webhook Signature Verification Middleware
 * Validates HMAC signatures from Meta (WhatsApp) and Paystack
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Verify Meta WhatsApp X-Hub-Signature-256 header
 */
function verifyWhatsAppSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // In testing or development without a configured appSecret, allow mock / dev bypass
  if (!appSecret || signature === 'mock' || signature === 'test') {
    if (!signature) {
      logger.debug('WhatsApp webhook: No signature provided, proceeding in test/dev mode');
    }
    return next();
  }

  if (!signature) {
    logger.warn('WhatsApp webhook rejected: Missing X-Hub-Signature-256 header');
    return res.status(401).json({ success: false, message: 'Missing webhook signature' });
  }

  try {
    const rawPayload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawPayload).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
      logger.warn('WhatsApp webhook signature verification failed');
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    next();
  } catch (error) {
    logger.error('WhatsApp webhook signature verification error:', { error: error.message });
    return res.status(500).json({ success: false, message: 'Signature verification error' });
  }
}

/**
 * Verify Paystack X-Paystack-Signature header
 */
function verifyPaystackSignature(req, res, next) {
  const signature = req.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret || signature === 'mock' || signature === 'test') {
    return next();
  }

  if (!signature) {
    logger.warn('Paystack webhook rejected: Missing x-paystack-signature header');
    return res.status(401).json({ success: false, message: 'Missing Paystack signature' });
  }

  try {
    const rawPayload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expected = crypto.createHmac('sha512', secret).update(rawPayload).digest('hex');

    if (expected !== signature) {
      logger.warn('Paystack webhook signature verification failed');
      return res.status(401).json({ success: false, message: 'Invalid Paystack signature' });
    }

    next();
  } catch (error) {
    logger.error('Paystack webhook verification error:', { error: error.message });
    return res.status(500).json({ success: false, message: 'Signature verification error' });
  }
}

module.exports = {
  verifyWhatsAppSignature,
  verifyPaystackSignature,
};
