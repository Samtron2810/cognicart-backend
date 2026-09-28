/**
 * JWT Token Generation and Verification Utility
 *
 * Two audiences share this secret, so every token carries a `typ` claim:
 *   typ 'seller'  -> staff/seller/admin tokens consumed by middleware/authMiddleware
 *   typ 'shopper' -> buyer tokens consumed by middleware/shopperMiddleware
 * Each middleware rejects the other's tokens; a missing `typ` is treated as
 * 'seller' so tokens issued before this claim existed keep working.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'wabac_jwt_super_secret_dev_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SHOPPER_JWT_EXPIRES_IN = process.env.SHOPPER_JWT_EXPIRES_IN || '30d';

const TOKEN_TYPES = {
  SELLER: 'seller',
  SHOPPER: 'shopper',
};

/**
 * Generate a signed seller/staff JWT token
 * @param {Object} payload - Data to embed in the token (e.g., { id, email, role })
 * @param {string} [expiresIn] - Optional custom expiry
 * @returns {string} - Signed JWT string
 */
function generateToken(payload, expiresIn = JWT_EXPIRES_IN) {
  return jwt.sign({ ...payload, typ: TOKEN_TYPES.SELLER }, JWT_SECRET, { expiresIn });
}

/**
 * Generate a signed buyer (shopper) JWT token
 * @param {Object} payload - e.g. { id, phone }
 * @param {string} [expiresIn] - Optional custom expiry
 */
function generateShopperToken(payload, expiresIn = SHOPPER_JWT_EXPIRES_IN) {
  return jwt.sign({ ...payload, typ: TOKEN_TYPES.SHOPPER }, JWT_SECRET, { expiresIn });
}

/**
 * Verify and decode a JWT token
 * @param {string} token - JWT token string
 * @returns {Object} - Decoded payload
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Token audience helper. Tokens minted before the `typ` claim existed are sellers.
 */
function getTokenType(decoded) {
  return (decoded && decoded.typ) || TOKEN_TYPES.SELLER;
}

module.exports = {
  generateToken,
  generateShopperToken,
  verifyToken,
  getTokenType,
  TOKEN_TYPES,
};
