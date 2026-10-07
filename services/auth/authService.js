/**
 * Authentication and User Service
 * MongoDB-backed. There is no in-memory fallback and no pre-seeded account:
 * every account must exist in the database.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../../models/User');
const Business = require('../../models/Business');
const SellerAuthToken = require('../../models/SellerAuthToken');
const { generateToken } = require('../../utils/generateToken');
const { isEmail, isStrongPassword, isNigerianPhone, normalizePhone, sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

const VALID_ROLES = ['seller', 'admin', 'platform_owner'];

const VERIFY_TTL_MS = 10 * 60 * 1000; // one-time code is valid for 10 minutes
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // one code per account per minute
const VERIFY_MAX_ATTEMPTS = 5; // wrong-code budget before the code is burned
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

const SECRET = process.env.JWT_SECRET || 'chatstand_jwt_super_secret_dev_key_2026';

function hashSecret(value) {
  return crypto.createHmac('sha256', SECRET).update(String(value)).digest('hex');
}

/**
 * Mirrors SHOP_OTP_DEBUG for the buyer flow: when enabled the generated code is
 * returned by the API so signup can be exercised without a mail provider.
 * Never enable this outside local development.
 */
function verifyOtpDebugEnabled() {
  return process.env.SELLER_OTP_DEBUG === 'true';
}

/** Six digit code, uniform over 100000-999999. */
function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Bind the code to the destination address so a code issued for one account can
 * never be replayed against another.
 */
function hashOtp(email, code) {
  return hashSecret(`${email}:${code}`);
}

function clientUrl() {
  return (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function getNotificationService() {
  // Lazy to avoid any load-order cycle with other services.
  return require('../notifications/notificationService');
}

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
   * `role` and `isEmailVerified` are trusted here, so this must only be called
   * by server-side code (registration endpoint, provisioning CLI, tests) -
   * never with user input.
   */
  async createAccount({ businessName, email, password, phone, role = 'seller', isEmailVerified = false }) {
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
        // Provisioned accounts (admin CLI) skip the signup OTP, so the caller
        // decides. Self-service registration always leaves this false.
        isEmailVerified: isEmailVerified === true,
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

    // Side effects only: account creation must succeed even if email fails.
    this.sendWelcomeAndVerification(user).catch((error) => {
      logger.warn('Could not send seller welcome/verification email:', {
        id: user._id.toString(),
        error: error.message,
      });
    });

    return { token, seller };
  },

  /**
   * Issue a verify-email one-time code and send the combined welcome + code
   * email. Called right after registration.
   */
  async sendWelcomeAndVerification(user) {
    const code = generateOtpCode();

    await SellerAuthToken.deleteMany({ userId: user._id, purpose: 'verify_email' });
    await SellerAuthToken.create({
      userId: user._id,
      email: user.email,
      purpose: 'verify_email',
      tokenHash: hashOtp(user.email, code),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });

    const result = await getNotificationService().sendSellerWelcome({
      email: user.email,
      businessName: user.businessName,
      code,
      expiresInMinutes: Math.floor(VERIFY_TTL_MS / 60000),
    });

    if (verifyOtpDebugEnabled()) {
      logger.warn('SELLER_OTP_DEBUG is on - verification code logged:', { email: user.email, code });
    }

    return result;
  },

  /**
   * Resend the verify-email code. Response is always generic so this cannot
   * be used to enumerate registered addresses.
   */
  async resendVerificationEmail(email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const genericResponse = {
      success: true,
      message: 'If that email belongs to an account needing verification, a new code is on its way.',
      expiresInSeconds: Math.floor(VERIFY_TTL_MS / 1000),
      resendAfterSeconds: Math.floor(VERIFY_RESEND_COOLDOWN_MS / 1000),
    };
    if (!isEmail(cleanEmail)) return genericResponse;

    const user = await User.findOne({ email: cleanEmail });
    if (!user || user.isEmailVerified) return genericResponse;

    // Cooldown is enforced silently: a throttled caller still gets the generic
    // response, so timing cannot be used to probe for accounts.
    const recent = await SellerAuthToken.findOne({
      userId: user._id,
      purpose: 'verify_email',
      usedAt: null,
      createdAt: { $gt: new Date(Date.now() - VERIFY_RESEND_COOLDOWN_MS) },
    }).sort({ createdAt: -1 });
    if (recent) return genericResponse;

    await SellerAuthToken.deleteMany({ userId: user._id, purpose: 'verify_email' });
    const code = generateOtpCode();

    await SellerAuthToken.create({
      userId: user._id,
      email: user.email,
      purpose: 'verify_email',
      tokenHash: hashOtp(user.email, code),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });

    await getNotificationService().sendSellerEmailVerification({
      email: user.email,
      businessName: user.businessName,
      code,
      expiresInMinutes: Math.floor(VERIFY_TTL_MS / 60000),
    });

    if (verifyOtpDebugEnabled()) {
      genericResponse.devCode = code;
    }

    return genericResponse;
  },

  /**
   * Redeem a verify-email one-time code. Single use, attempt limited, and
   * bound to the exact email address the code was issued for.
   *
   * Returns a fresh session so a seller who verifies from a different device
   * than the one they signed up on ends up logged in.
   */
  async verifyEmailOtp({ email, code }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanCode = String(code || '').trim();

    if (!isEmail(cleanEmail)) throw badRequest('A valid email address is required');
    if (!cleanCode) throw badRequest('Verification code is required');
    if (!/^\d{6}$/.test(cleanCode)) throw badRequest('Verification code must be 6 digits');

    const challenge = await SellerAuthToken.findOne({
      email: cleanEmail,
      purpose: 'verify_email',
      usedAt: null,
    }).sort({ createdAt: -1 });

    // Unknown address and no outstanding code look identical on purpose.
    if (!challenge) throw badRequest('That code is not valid. Please request a new one.', 401);

    if (challenge.expiresAt.getTime() < Date.now()) {
      await SellerAuthToken.deleteOne({ _id: challenge._id });
      throw badRequest('That code has expired. Please request a new one.', 401);
    }

    if (challenge.attempts >= VERIFY_MAX_ATTEMPTS) {
      await SellerAuthToken.deleteOne({ _id: challenge._id });
      throw badRequest('Too many incorrect attempts. Please request a new code.', 429);
    }

    if (challenge.tokenHash !== hashOtp(cleanEmail, cleanCode)) {
      challenge.attempts += 1;
      await challenge.save();
      const left = Math.max(VERIFY_MAX_ATTEMPTS - challenge.attempts, 0);
      throw badRequest(
        left > 0
          ? `Incorrect verification code. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'Incorrect verification code. Please request a new one.',
        401
      );
    }

    const user = await User.findById(challenge.userId);
    if (!user) throw badRequest('Seller not found', 404);

    challenge.usedAt = new Date();
    await challenge.save();
    // Burn every other outstanding code for this account.
    await SellerAuthToken.deleteMany({
      userId: user._id,
      purpose: 'verify_email',
      _id: { $ne: challenge._id },
    });

    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      await user.save();
    }

    logger.info('Seller email verified:', { id: user._id.toString() });

    const token = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
    return { token, seller: user.toJSON() };
  },

  /**
   * Issue a password-reset challenge. Response is always generic so this
   * cannot be used to enumerate registered addresses.
   */
  async forgotPassword(email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const genericResponse = {
      success: true,
      message: 'If that email is registered, a password reset link is on its way.',
    };
    if (!isEmail(cleanEmail)) return genericResponse;

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return genericResponse;

    const recent = await SellerAuthToken.findOne({
      userId: user._id,
      purpose: 'reset_password',
      usedAt: null,
      createdAt: { $gt: new Date(Date.now() - RESET_RESEND_COOLDOWN_MS) },
    }).sort({ createdAt: -1 });
    if (recent) return genericResponse;

    await SellerAuthToken.deleteMany({ userId: user._id, purpose: 'reset_password', usedAt: null });
    const rawToken = crypto.randomBytes(32).toString('hex');

    await SellerAuthToken.create({
      userId: user._id,
      email: user.email,
      purpose: 'reset_password',
      tokenHash: hashSecret(rawToken),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    const resetUrl = `${clientUrl()}/reset-password?t=${rawToken}`;

    await getNotificationService().sendSellerPasswordReset({
      email: user.email,
      businessName: user.businessName,
      resetUrl,
      expiresInMinutes: Math.floor(RESET_TTL_MS / 60000),
    });

    return genericResponse;
  },

  /**
   * Redeem a password-reset token and set a new password. Single use.
   */
  async resetPassword({ token: rawToken, password }) {
    const token = String(rawToken || '').trim();
    if (!token) throw badRequest('Reset token is required');
    if (!isStrongPassword(password)) {
      throw badRequest('Password must be at least 8 characters and contain at least one uppercase letter and one number');
    }

    const challenge = await SellerAuthToken.findOne({
      purpose: 'reset_password',
      tokenHash: hashSecret(token),
    });

    if (!challenge) throw badRequest('This reset link is not valid', 401);
    if (challenge.usedAt) throw badRequest('This reset link has already been used. Request a new one.', 401);
    if (challenge.expiresAt.getTime() < Date.now()) throw badRequest('This reset link has expired. Request a new one.', 401);

    const user = await User.findById(challenge.userId).select('+password');
    if (!user) throw badRequest('Seller not found', 404);

    challenge.usedAt = new Date();
    await challenge.save();

    user.password = password;
    await user.save();

    logger.info('Seller password reset:', { id: user._id.toString() });

    getNotificationService()
      .sendSellerPasswordChanged({ email: user.email, businessName: user.businessName })
      .catch((error) => logger.warn('Could not send password-changed notice:', { error: error.message }));

    const token2 = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
    return { token: token2, seller: user.toJSON() };
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
