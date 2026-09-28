/**
 * Buyer (Shopper) Authentication Middleware
 *
 * Deliberately separate from middleware/authMiddleware: a shopper session must
 * never populate `req.sellerId`, or a buyer token would grant access to a
 * seller's tenant data. Buyer sessions also use their own cookie name so a
 * shopper and a seller can be signed in on the same browser.
 */

const { verifyToken, getTokenType, TOKEN_TYPES } = require('../utils/generateToken');
const Shopper = require('../models/Shopper');
const logger = require('../utils/logger');

const SHOPPER_COOKIE = 'shop_token';

function extractToken(req) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req.cookies && req.cookies[SHOPPER_COOKIE]) {
    return req.cookies[SHOPPER_COOKIE];
  }
  return null;
}

async function resolveShopper(token) {
  const decoded = verifyToken(token);

  if (getTokenType(decoded) !== TOKEN_TYPES.SHOPPER) {
    const err = new Error('Not a shopper token');
    err.code = 'WRONG_TOKEN_TYPE';
    throw err;
  }

  const shopper = await Shopper.findById(decoded.id);
  if (!shopper) {
    const err = new Error('Shopper account no longer exists');
    err.code = 'SHOPPER_NOT_FOUND';
    throw err;
  }

  return shopper;
}

/**
 * Require a verified buyer session.
 */
async function protectShopper(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized: verify your contact details to continue',
    });
  }

  try {
    const shopper = await resolveShopper(token);
    req.shopper = shopper;
    req.shopperId = shopper._id.toString();
    next();
  } catch (error) {
    logger.warn('Shopper token verification failed:', { error: error.message });
    return res.status(401).json({
      success: false,
      message:
        error.name === 'TokenExpiredError'
          ? 'Session expired. Please verify your contact details again.'
          : 'Invalid buyer session',
    });
  }
}

/**
 * Attach the buyer when a valid session is present; continue silently otherwise.
 * Used on guest-friendly endpoints such as checkout.
 */
async function optionalShopper(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const shopper = await resolveShopper(token);
    req.shopper = shopper;
    req.shopperId = shopper._id.toString();
  } catch {
    // An invalid or seller-typed token simply means "treat this as a guest"
  }

  next();
}

module.exports = {
  protectShopper,
  optionalShopper,
  SHOPPER_COOKIE,
};
