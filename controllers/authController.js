/**
 * Authentication Controller
 * Handles seller registration, login, profile retrieval, and logout
 */

const authService = require('../services/auth/authService');
const {
  sellerSessionCookieOptions,
  clearSessionCookieOptions,
} = require('../utils/sessionCookie');

/**
 * @route   POST /api/auth/register
 * @desc    Register a new seller account
 * @access  Public
 */
async function register(req, res, next) {
  try {
    // NOTE: `role` is deliberately ignored - self-service signup always creates
    // a 'seller'. Privileged accounts are provisioned with `npm run create-admin`.
    const { businessName, email, password, phone } = req.body;
    const result = await authService.register({ businessName, email, password, phone });

    // The httpOnly cookie survives application remounts and responsive view
    // changes; production allows credentialed requests from the storefront.
    res.cookie('token', result.token, sellerSessionCookieOptions());

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate seller & get token
 * @access  Public
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login({ email, password });

    res.cookie('token', result.token, sellerSessionCookieOptions());

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated seller profile
 * @access  Private
 */
async function getMe(req, res, next) {
  try {
    const seller = await authService.getMe(req.sellerId);
    res.status(200).json(seller);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/auth/logout
 * @desc    Log out seller & clear cookie
 * @access  Public
 */
function logout(req, res) {
  // Clearing must use the same host/path/security attributes as issuance.
  res.clearCookie('token', clearSessionCookieOptions());

  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
}

/**
 * @route   POST /api/auth/resend-verification
 * @desc    Resend the verify-email link
 * @access  Public
 */
async function resendVerification(req, res, next) {
  try {
    const { email } = req.body;
    const result = await authService.resendVerificationEmail(email);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/auth/verify-email?token=...
 * @desc    Redeem a verify-email token
 * @access  Public
 */
async function verifyEmail(req, res, next) {
  try {
    const token = req.query.token || req.body.token;
    const seller = await authService.verifyEmail(token);
    res.status(200).json({ success: true, seller });
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request a password-reset link
 * @access  Public
 */
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const result = await authService.forgotPassword(email);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/auth/reset-password
 * @desc    Redeem a reset token and set a new password
 * @access  Public
 */
async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    const result = await authService.resetPassword({ token, password });

    res.cookie('token', result.token, sellerSessionCookieOptions());
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  register,
  login,
  getMe,
  logout,
  resendVerification,
  verifyEmail,
  forgotPassword,
  resetPassword,
};
