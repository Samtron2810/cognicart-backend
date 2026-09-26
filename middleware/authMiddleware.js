/**
 * Authentication and Authorization Middleware
 * Enforces JWT verification, seller tenant context injection, and role-based access control
 */

const { verifyToken } = require('../utils/generateToken');
const authService = require('../services/auth/authService');
const logger = require('../utils/logger');

/**
 * Protect routes: verify JWT Bearer token and attach tenant context
 */
async function protect(req, res, next) {
  let token = null;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized: No authentication token provided',
    });
  }

  try {
    const decoded = verifyToken(token);
    const user = await authService.findUserById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized: User account no longer exists',
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account suspended. Contact platform support.',
      });
    }

    // Attach authenticated user and multi-tenant identity
    req.user = user;
    req.seller = user;
    req.sellerId = (user._id ? user._id.toString() : user.id).toString();

    next();
  } catch (error) {
    logger.warn('Authentication token verification failed:', { error: error.message });
    return res.status(401).json({
      success: false,
      message: error.name === 'TokenExpiredError' ? 'Token expired. Please log in again.' : 'Invalid authentication token',
    });
  }
}

/**
 * Optional authentication: attaches user if token is valid, proceeds without error otherwise
 */
async function optionalAuth(req, res, next) {
  let token = null;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) return next();

  try {
    const decoded = verifyToken(token);
    const user = await authService.findUserById(decoded.id);
    if (user && user.isActive !== false) {
      req.user = user;
      req.seller = user;
      req.sellerId = (user._id ? user._id.toString() : user.id).toString();
    }
  } catch {}
  next();
}

/**
 * Role-based access control middleware
 * @param  {...string} roles - e.g. 'admin', 'platform_owner', 'seller'
 */
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Role '${req.user ? req.user.role : 'unauthenticated'}' is not authorized to access this resource`,
      });
    }
    next();
  };
}

module.exports = {
  protect,
  optionalAuth,
  authorizeRoles,
};
