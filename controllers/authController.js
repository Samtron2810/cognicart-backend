/**
 * Authentication Controller
 * Handles seller registration, login, profile retrieval, and logout
 */

const authService = require('../services/auth/authService');

/**
 * @route   POST /api/auth/register
 * @desc    Register a new seller account
 * @access  Public
 */
async function register(req, res, next) {
  try {
    const { businessName, email, password, phone, role } = req.body;
    const result = await authService.register({ businessName, email, password, phone, role });

    // Set secure cookie
    res.cookie('token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

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

    res.cookie('token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

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
  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
  });

  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
}

module.exports = {
  register,
  login,
  getMe,
  logout,
};
