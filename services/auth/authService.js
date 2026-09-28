/**
 * Authentication and User Service
 * MongoDB-backed. There is no in-memory fallback and no pre-seeded account:
 * every account must exist in the database.
 */

const mongoose = require('mongoose');
const User = require('../../models/User');
const Business = require('../../models/Business');
const { generateToken } = require('../../utils/generateToken');
const { isEmail, isStrongPassword, isNigerianPhone, normalizePhone, sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

const VALID_ROLES = ['seller', 'admin', 'platform_owner'];

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Validate and normalize a signup payload shared by registration and provisioning.
 */
function normalizeSignupPayload({ businessName, email, password, phone }) {
  if (!businessName || typeof businessName !== 'string') {
    throw badRequest('Business name is required');
  }

  const cleanName = sanitize(businessName, 80);
  if (cleanName.length < 2) {
    throw badRequest('Business name must be at least 2 characters');
  }

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!isEmail(cleanEmail)) {
    throw badRequest('Invalid email format');
  }

  if (!isStrongPassword(password)) {
    throw badRequest(
      'Password must be at least 8 characters and contain at least one uppercase letter and one number'
    );
  }

  let cleanPhone = (phone || '').trim();
  if (cleanPhone && !isNigerianPhone(cleanPhone)) {
    throw badRequest('Invalid Nigerian phone number format');
  }
  if (cleanPhone) {
    cleanPhone = normalizePhone(cleanPhone);
  }

  return { cleanName, cleanEmail, cleanPhone };
}

const authService = {
  /**
   * Create a user account together with its default business profile.
   * `role` is trusted here, so this must only be called by server-side code
   * (registration endpoint, provisioning CLI, tests) - never with user input.
   */
  async createAccount({ businessName, email, password, phone, role = 'seller' }) {
    const { cleanName, cleanEmail, cleanPhone } = normalizeSignupPayload({
      businessName,
      email,
      password,
      phone,
    });

    if (!VALID_ROLES.includes(role)) {
      throw badRequest(`Invalid role. Allowed roles: ${VALID_ROLES.join(', ')}`);
    }

    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      throw badRequest('Email already registered', 409);
    }

    let user;
    try {
      user = await User.create({
        businessName: cleanName,
        email: cleanEmail,
        password,
        phone: cleanPhone,
        role,
        isActive: true,
      });
    } catch (error) {
      // Unique index race condition on email
      if (error && error.code === 11000) {
        throw badRequest('Email already registered', 409);
      }
      throw error;
    }

    const sellerId = user._id.toString();

    // Automatically initialize the default business profile
    try {
      await Business.create({
        sellerId,
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
      });
    } catch (error) {
      if (!error || error.code !== 11000) {
        // Roll back the orphaned user so registration stays atomic enough to retry
        await User.deleteOne({ _id: user._id }).catch(() => {});
        throw error;
      }
    }

    return user;
  },

  /**
   * Register a new seller.
   * Self-service registration can only ever create a 'seller' account -
   * privileged roles are provisioned with `npm run create-admin`.
   */
  async register({ businessName, email, password, phone }) {
    const user = await this.createAccount({ businessName, email, password, phone, role: 'seller' });

    const token = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
    const seller = user.toJSON();

    logger.info('Seller registered successfully:', { id: user._id.toString(), email: user.email });
    return { token, seller };
  },

  /**
   * Log in an existing user
   */
  async login({ email, password }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !password || typeof password !== 'string') {
      throw badRequest('Email and password are required');
    }

    const user = await User.findOne({ email: cleanEmail }).select('+password');
    if (!user) {
      throw badRequest('Invalid email or password', 401);
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      throw badRequest('Invalid email or password', 401);
    }

    if (user.isActive === false) {
      throw badRequest('Account suspended. Contact platform support.', 403);
    }

    const token = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
    const seller = user.toJSON();

    logger.info('Seller logged in:', { id: user._id.toString(), email: user.email });
    return { token, seller };
  },

  /**
   * Retrieve current authenticated user profile
   */
  async getMe(userId) {
    const user = await this.findUserById(userId);
    if (!user) {
      throw badRequest('Seller not found', 404);
    }
    return user.toJSON();
  },

  /**
   * Find user by ID (for auth middleware). Returns null for unknown/invalid ids.
   */
  async findUserById(userId) {
    if (!userId || !mongoose.isValidObjectId(userId)) return null;
    return User.findById(userId);
  },
};

module.exports = authService;
module.exports.VALID_ROLES = VALID_ROLES;
