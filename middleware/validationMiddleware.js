/**
 * Validation and Request Sanitization Middleware
 */

const { sanitize, clampRequestSize } = require('../utils/validators');

/**
 * Middleware to sanitize all string fields in request body
 */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    const sanitizeRecursive = (obj) => {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string') {
          obj[key] = sanitize(obj[key]);
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeRecursive(obj[key]);
        }
      }
    };
    sanitizeRecursive(req.body);
  }
  next();
}

/**
 * Middleware to enforce request body size constraint (500KB)
 */
function validatePayloadSize(maxKB = 500) {
  return (req, res, next) => {
    if (req.body) {
      const payloadStr = JSON.stringify(req.body);
      if (!clampRequestSize(payloadStr, maxKB)) {
        return res.status(413).json({
          success: false,
          message: `Payload too large (${maxKB}KB limit exceeded)`,
        });
      }
    }
    next();
  };
}

module.exports = {
  sanitizeBody,
  validatePayloadSize,
};
