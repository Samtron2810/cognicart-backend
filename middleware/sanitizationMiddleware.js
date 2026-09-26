/**
 * Request Sanitization and NoSQL Injection Defense Middleware
 * Inspects request body, query parameters, and route parameters to block MongoDB injection operators
 */

const logger = require('../utils/logger');

function containsNoSqlInjection(obj) {
  if (!obj || typeof obj !== 'object') return false;

  for (const key of Object.keys(obj)) {
    // MongoDB query operators start with $
    if (key.startsWith('$')) {
      return true;
    }
    // Allow standard Meta webhook parameters (hub.mode, hub.challenge, hub.verify_token)
    if (key.includes('.') && !key.startsWith('hub.')) {
      return true;
    }
    const val = obj[key];
    if (val && typeof val === 'object' && containsNoSqlInjection(val)) {
      return true;
    }
  }

  return false;
}

function sanitizeInput(req, res, next) {
  if (containsNoSqlInjection(req.body) || containsNoSqlInjection(req.query) || containsNoSqlInjection(req.params)) {
    logger.warn('Blocked NoSQL operator injection attempt:', {
      ip: req.ip || req.headers['x-forwarded-for'],
      method: req.method,
      url: req.originalUrl,
    });
    return res.status(400).json({
      success: false,
      message: 'Invalid request payload: prohibited query operator detected',
    });
  }

  next();
}

module.exports = sanitizeInput;
