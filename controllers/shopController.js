/**
 * Buyer (Shopper) Controller
 * Email-verified buyer sessions, profile, and cross-store order history
 */

const shopperAuthService = require('../services/shop/shopperAuthService');
const shopperService = require('../services/shop/shopperService');
const { SHOPPER_COOKIE } = require('../middleware/shopperMiddleware');
const {
  shopperSessionCookieOptions,
  clearSessionCookieOptions,
} = require('../utils/sessionCookie');

const shopController = {
  /**
   * @route   POST /api/shop/auth/request-otp
   * @desc    Send a one-time verification code through Brevo email
   * @access  Public (rate limited)
   */
  async requestOtp(req, res, next) {
    try {
      const { phone, sellerId, email } = req.body;
      const result = await shopperAuthService.requestOtp({ phone, sellerId, email });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/shop/auth/verify-otp
   * @desc    Exchange a verification code for a buyer session
   * @access  Public (rate limited)
   */
  async verifyOtp(req, res, next) {
    try {
      const { phone, email, code } = req.body;
      const result = await shopperAuthService.verifyOtp({ phone, email, code });

      res.cookie(SHOPPER_COOKIE, result.token, shopperSessionCookieOptions());
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/shop/auth/magic
   * @desc    Redeem a single-use tracking link token for a buyer session
   * @access  Public (rate limited)
   *
   * Deliberately POST, not GET: email security scanners and link previews often
   * fetch URLs automatically and would otherwise burn the token before a buyer
   * taps it.
   */
  async consumeMagicLink(req, res, next) {
    try {
      const token = req.body.token || req.query.t;
      const result = await shopperAuthService.consumeMagicLink(token);

      res.cookie(SHOPPER_COOKIE, result.token, shopperSessionCookieOptions());
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/shop/auth/logout
   * @desc    Clear the buyer session cookie
   * @access  Public
   */
  async logout(req, res) {
    res.clearCookie(SHOPPER_COOKIE, clearSessionCookieOptions());
    res.status(200).json({ success: true, message: 'Signed out' });
  },

  /**
   * @route   GET /api/shop/me
   * @desc    Buyer profile, saved addresses, and stores shopped
   * @access  Buyer session
   */
  async getMe(req, res, next) {
    try {
      const profile = await shopperService.getProfile(req.shopper);
      res.status(200).json(profile);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   PATCH /api/shop/me
   * @desc    Update display name (email changes require re-verification)
   * @access  Buyer session
   */
  async updateMe(req, res, next) {
    try {
      const { name, email } = req.body;
      const shopper = await shopperAuthService.updateProfile(req.shopperId, { name, email });
      res.status(200).json(shopper);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/shop/me/orders
   * @desc    Cross-store purchase history for the verified buyer
   * @access  Buyer session
   */
  async getMyOrders(req, res, next) {
    try {
      const { sellerId, status, paymentStatus } = req.query;
      const orders = await shopperService.listOrders(req.shopper, { sellerId, status, paymentStatus });
      res.status(200).json(orders);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/shop/me/orders/:id
   * @desc    Single order, scoped to the verified buyer
   * @access  Buyer session
   */
  async getMyOrderById(req, res, next) {
    try {
      const order = await shopperService.getOrderById(req.shopper, req.params.id);
      res.status(200).json(order);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = shopController;
