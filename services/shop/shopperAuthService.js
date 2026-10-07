/**
 * Buyer (Shopper) Authentication Service
 *
 * Progressive identity: buyers never register and never hold a password.
 * They become identifiable in one of two ways:
 *
 *   1. Magic link  - embedded in the Brevo order-confirmation email.
 *                    One tap, single use, no code to type.
 *   2. One-time code - emailed to an address already associated at checkout.
 *      Telegram-originated buyers will receive the same events in-bot once the
 *      Telegram transport is registered.
 *
 * Verifying the email associated with a phone creates (or reuses) the global
 * `Shopper` and claims only guest Order/Customer rows carrying that exact pair.
 * A phone match alone is never treated as proof of ownership.
 */

const crypto = require('crypto');

const Shopper = require('../../models/Shopper');
const ShopperAuthToken = require('../../models/ShopperAuthToken');
const Customer = require('../../models/Customer');
const Order = require('../../models/Order');
const { generateShopperToken } = require('../../utils/generateToken');
const { normalizePhone, isNigerianPhone, isEmail, sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

const OTP_TTL_MS = 10 * 60 * 1000; // code is valid for 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // one code per phone per minute
const OTP_MAX_ATTEMPTS = 5;
const MAGIC_TTL_MS = 7 * 24 * 60 * 60 * 1000; // tracking links live for a week

const SECRET = process.env.JWT_SECRET || 'chatstand_jwt_super_secret_dev_key_2026';

function getNotificationService() {
  // Lazy to avoid the order-confirmation -> magic-link cycle at module load.
  return require('../notifications/notificationService');
}

/**
 * Codes and link tokens are only ever stored hashed.
 */
function hashSecret(value) {
  return crypto.createHmac('sha256', SECRET).update(String(value)).digest('hex');
}

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * When enabled, the generated code is returned by the API so the flow can be
 * exercised without a live Brevo account. Never enable this in production.
 */
function otpDebugEnabled() {
  return process.env.SHOP_OTP_DEBUG === 'true';
}

function requirePhone(phone) {
  const raw = (phone || '').trim();
  if (!raw) throw badRequest('Phone number is required');

  const clean = normalizePhone(raw) || raw;
  if (!isNigerianPhone(raw) && !/^\+?\d{7,15}$/.test(clean)) {
    throw badRequest('Invalid phone number format');
  }

  return clean;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!isEmail(email)) throw badRequest('Invalid email address');
  return email;
}

/**
 * Resolve an OTP destination that was already associated with this phone. The
 * requested address is a selector, not a new association: this prevents an
 * attacker from entering a victim's phone and routing the code to themselves.
 */
async function resolveOtpEmail(phone, sellerId = '', requestedEmail = '') {
  const requested = normalizeEmail(requestedEmail);
  if (!requested) return '';

  const [shopper, customer, order] = await Promise.all([
    Shopper.findOne({ phone, email: requested }).select('email'),
    Customer.findOne({
      phone,
      email: requested,
      ...(sellerId ? { sellerId } : {}),
    })
      .sort({ lastOrderAt: -1, createdAt: -1 })
      .select('email'),
    Order.findOne({
      customerPhone: phone,
      customerEmail: requested,
      ...(sellerId ? { sellerId } : {}),
    }).select('customerEmail'),
  ]);

  return shopper || customer || order ? requested : '';
}

const shopperAuthService = {
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  MAGIC_TTL_MS,

  /**
   * Issue a 6 digit code over Brevo email.
   *
   * The destination must already be associated with this phone by checkout or
   * a verified profile. Responses stay generic so callers cannot enumerate
   * which phone numbers/emails are in the database.
   */
  async requestOtp({ phone, sellerId = '', email = '' }) {
    const cleanPhone = requirePhone(phone);
    const debug = otpDebugEnabled();
    let destination = await resolveOtpEmail(cleanPhone, sellerId, email);
    // Debug mode may exercise a brand-new pair without a prior checkout. The
    // code is exposed in the response, so no account-existence guarantee is
    // implied; this branch must never be enabled in production.
    if (!destination && debug) destination = normalizeEmail(email);
    if (!destination && debug) throw badRequest('Email is required when SHOP_OTP_DEBUG is enabled');

    const genericResponse = {
      success: true,
      message: 'If that phone number has an email on file, a verification code is on its way.',
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    };

    // In production, unknown phone/email pairs do not get a challenge at all.
    // Debug mode still creates one so local suites can test identity without a
    // configured email provider.
    if (!destination && !debug) return genericResponse;

    // Throttle resends per verified contact pair (the IP limiter sits on the route)
    const recent = await ShopperAuthToken.findOne({
      phone: cleanPhone,
      email: destination,
      purpose: 'otp',
      usedAt: null,
      createdAt: { $gt: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
    }).sort({ createdAt: -1 });

    if (recent) {
      // Production keeps the same 200 response for known and unknown phones so
      // the cooldown itself cannot be used as an account-enumeration oracle.
      if (!debug) return genericResponse;
      const retryIn = Math.ceil((recent.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
      throw badRequest(`A code was just sent. Please wait ${Math.max(retryIn, 1)}s before requesting another.`, 429);
    }

    await ShopperAuthToken.deleteMany({ phone: cleanPhone, email: destination, purpose: 'otp' });
    const code = String(crypto.randomInt(100000, 1000000));

    await ShopperAuthToken.create({
      phone: cleanPhone,
      email: destination,
      purpose: 'otp',
      tokenHash: hashSecret(`${cleanPhone}:${destination}:${code}`),
      sellerId,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });

    const delivery = destination
      ? await getNotificationService().sendBuyerOtp({
          email: destination,
          code,
          expiresInMinutes: Math.floor(OTP_TTL_MS / 60000),
        })
      : { delivered: false, reason: 'debug_without_destination' };

    if (!delivery.delivered) {
      logger.warn('Shopper OTP email was not delivered:', {
        phone: cleanPhone,
        reason: delivery.reason,
      });
    }

    if (debug) {
      genericResponse.devCode = code;
      genericResponse.delivered = Boolean(delivery.delivered);
    }
    return genericResponse;
  },

  /**
   * Exchange the same phone+email pair and its code for a buyer session.
   */
  async verifyOtp({ phone, email, code }) {
    const cleanPhone = requirePhone(phone);
    const cleanEmail = normalizeEmail(email);
    const cleanCode = String(code || '').trim();

    if (!cleanEmail) throw badRequest('Email is required');
    if (!cleanCode) throw badRequest('Verification code is required');

    const challenge = await ShopperAuthToken.findOne({
      phone: cleanPhone,
      email: cleanEmail,
      purpose: 'otp',
      usedAt: null,
    }).sort({ createdAt: -1 });

    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      throw badRequest('That code has expired. Please request a new one.', 401);
    }

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      throw badRequest('Too many incorrect attempts. Please request a new code.', 429);
    }

    if (challenge.tokenHash !== hashSecret(`${cleanPhone}:${cleanEmail}:${cleanCode}`)) {
      challenge.attempts += 1;
      await challenge.save();
      throw badRequest('Incorrect verification code', 401);
    }

    challenge.usedAt = new Date();
    await challenge.save();

    return this.establishSession({ phone: cleanPhone, email: challenge.email });
  },

  /**
   * Mint a single-use magic link token for a phone number.
   * Returned value is the raw token: store it nowhere but the outbound message.
   */
  async createMagicLink({ phone, email, sellerId = '', orderId = '' }) {
    const cleanPhone = requirePhone(phone);
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) throw badRequest('Email is required for a tracking link');
    const rawToken = crypto.randomBytes(32).toString('hex');

    await ShopperAuthToken.create({
      phone: cleanPhone,
      email: cleanEmail,
      purpose: 'magic',
      tokenHash: hashSecret(rawToken),
      sellerId,
      orderId,
      expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
    });

    const base = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
    return {
      token: rawToken,
      url: `${base}/track?t=${rawToken}`,
      expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
    };
  },

  /**
   * Redeem a magic link token for a buyer session. Single use.
   */
  async consumeMagicLink(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) throw badRequest('Link token is required');

    const challenge = await ShopperAuthToken.findOne({
      purpose: 'magic',
      tokenHash: hashSecret(token),
    });

    if (!challenge) throw badRequest('This link is not valid', 401);
    if (challenge.usedAt) throw badRequest('This link has already been used. Request a new code to sign in.', 401);
    if (challenge.expiresAt.getTime() < Date.now()) throw badRequest('This link has expired', 401);

    challenge.usedAt = new Date();
    await challenge.save();

    return this.establishSession({ phone: challenge.phone, email: challenge.email });
  },

  /**
   * Upsert the Shopper, claim only rows matching the proven phone+email pair,
   * and mint the session token.
   */
  async establishSession({ phone, email }) {
    const cleanPhone = requirePhone(phone);
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) throw badRequest('This challenge has no verified email', 401);
    const now = new Date();

    let shopper = await Shopper.findOne({ email: cleanEmail });

    if (!shopper) {
      try {
        shopper = await Shopper.create({
          phone: cleanPhone,
          email: cleanEmail,
          verifiedAt: now,
          lastLoginAt: now,
        });
      } catch (error) {
        if (error && error.code === 11000) {
          shopper = await Shopper.findOne({ email: cleanEmail });
        } else {
          throw error;
        }
      }
    } else {
      // Email is the proven identity. Phone is a mutable contact attribute; a
      // newly verified pair may claim its own matching rows, never phone-only rows.
      shopper.phone = cleanPhone;
      shopper.verifiedAt = shopper.verifiedAt || now;
      shopper.lastLoginAt = now;
      await shopper.save();
    }

    const claimed = await this.claimHistory(shopper, { phone: cleanPhone, email: cleanEmail });

    if (!shopper.name && claimed.name) {
      shopper.name = claimed.name;
      await shopper.save();
    }

    const token = generateShopperToken({ id: shopper._id.toString(), phone: shopper.phone });

    logger.info('Shopper session established:', {
      shopperId: shopper._id.toString(),
      claimedOrders: claimed.orders,
      claimedCustomerRecords: claimed.customers,
    });

    return { token, shopper: shopper.toJSON(), claimed };
  },

  /**
   * Link only guest rows carrying the exact contact pair whose email control was
   * proven. A shared/forged phone number alone never grants ownership.
   */
  async claimHistory(shopper, { phone, email }) {
    const shopperId = shopper._id.toString();

    const [customerRes, orderRes, sample] = await Promise.all([
      Customer.updateMany({ phone, email, shopperId: null }, { $set: { shopperId } }),
      Order.updateMany(
        { customerPhone: phone, customerEmail: email, shopperId: null },
        { $set: { shopperId } }
      ),
      Customer.findOne({ phone, email }).sort({ createdAt: -1 }),
    ]);

    return {
      customers: customerRes.modifiedCount || 0,
      orders: orderRes.modifiedCount || 0,
      name: sample ? sample.name : '',
      email: sample ? sample.email : '',
    };
  },

  /**
   * Update the buyer's own profile fields.
   */
  async updateProfile(shopperId, payload = {}) {
    const shopper = await Shopper.findById(shopperId);
    if (!shopper) throw badRequest('Shopper not found', 404);

    if (payload.name !== undefined) shopper.name = sanitize(payload.name, 100);
    if (payload.email !== undefined) {
      const requested = normalizeEmail(payload.email);
      if (requested !== shopper.email) {
        throw badRequest('Email changes require a new verification flow');
      }
    }

    await shopper.save();
    return shopper.toJSON();
  },
};

module.exports = shopperAuthService;
