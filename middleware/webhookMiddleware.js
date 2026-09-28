/** Paystack webhook signature verification. */

const crypto = require('crypto');
const logger = require('../utils/logger');

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

module.exports = { verifyPaystackSignature };
