/** Paystack webhook signature verification. */

const crypto = require('crypto');
const logger = require('../utils/logger');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function verifyPaystackSignature(req, res, next) {
  const signature = String(req.headers['x-paystack-signature'] || '');
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();

  if (!secret || secret.includes('your_')) {
    logger.error('Paystack webhook rejected: PAYSTACK_SECRET_KEY is not configured');
    return res.status(503).json({ success: false, message: 'Payment verification is unavailable' });
  }
  if (!signature) {
    logger.warn('Paystack webhook rejected: missing signature');
    return res.status(401).json({ success: false, message: 'Missing Paystack signature' });
  }
  if (!Buffer.isBuffer(req.rawBody)) {
    logger.error('Paystack webhook rejected: exact raw request bytes are unavailable');
    return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
  }

  try {
    const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
    if (!safeEqual(expected, signature)) {
      logger.warn('Paystack webhook signature verification failed');
      return res.status(401).json({ success: false, message: 'Invalid Paystack signature' });
    }
    next();
  } catch (error) {
    logger.error('Paystack webhook verification error:', { error: error.message });
    return res.status(500).json({ success: false, message: 'Signature verification error' });
  }
}

module.exports = { verifyPaystackSignature };
