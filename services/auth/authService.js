/**
 * Authentication and User Service
 * Supports MongoDB with seamless in-memory fallback for local development/testing
 */

const bcrypt = require('bcryptjs');
const User = require('../../models/User');
const Business = require('../../models/Business');
const { generateToken } = require('../../utils/generateToken');
const { isDbConnected } = require('../../config/db');
const { isEmail, isStrongPassword, isNigerianPhone, normalizePhone, sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryUsers = new Map();
const memoryBusinesses = new Map();

// Seed initial admin & platform owner accounts for dev/testing
function seedDefaultAccounts() {
  if (memoryUsers.size > 0) return;

  const adminPasswordHash = bcrypt.hashSync('Admin123!', 10);
  const ownerPasswordHash = bcrypt.hashSync('Owner123!', 10);

  const admin = {
    id: 'seller_admin',
    _id: 'seller_admin',
    businessName: 'Cognicart Platform',
    email: 'admin@cognicart.ng',
    phone: '+2348000000000',
    password: adminPasswordHash,
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const owner = {
    id: 'seller_owner',
    _id: 'seller_owner',
    businessName: 'Cognicart Owner',
    email: 'owner@cognicart.ng',
    phone: '+2348000000001',
    password: ownerPasswordHash,
    role: 'platform_owner',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  memoryUsers.set(admin.id, admin);
  memoryUsers.set(admin.email.toLowerCase(), admin);

  memoryUsers.set(owner.id, owner);
  memoryUsers.set(owner.email.toLowerCase(), owner);
}

seedDefaultAccounts();

const authService = {
  /**
   * Register a new seller
   */
  async register({ businessName, email, password, phone, role }) {
    if (!businessName || typeof businessName !== 'string') {
      const err = new Error('Business name is required');
      err.statusCode = 400;
      throw err;
    }

    const cleanName = sanitize(businessName, 80);
    if (cleanName.length < 2) {
      const err = new Error('Business name must be at least 2 characters');
      err.statusCode = 400;
      throw err;
    }

    const cleanEmail = (email || '').trim().toLowerCase();
    if (!isEmail(cleanEmail)) {
      const err = new Error('Invalid email format');
      err.statusCode = 400;
      throw err;
    }

    if (!isStrongPassword(password)) {
      const err = new Error('Password must be at least 8 characters and contain at least one uppercase letter and one number');
      err.statusCode = 400;
      throw err;
    }

    let cleanPhone = (phone || '').trim();
    if (cleanPhone && !isNigerianPhone(cleanPhone)) {
      const err = new Error('Invalid Nigerian phone number format');
      err.statusCode = 400;
      throw err;
    }
    if (cleanPhone) {
      cleanPhone = normalizePhone(cleanPhone);
    }

    // Role assignment
    const defaultRole = cleanEmail.includes('admin@')
      ? 'admin'
      : cleanEmail.includes('owner@')
      ? 'platform_owner'
      : role || 'seller';

    if (isDbConnected()) {
      const existingUser = await User.findOne({ email: cleanEmail });
      if (existingUser) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }

      const user = await User.create({
        businessName: cleanName,
        email: cleanEmail,
        password,
        phone: cleanPhone,
        role: defaultRole,
        isActive: true,
      });

      // Automatically initialize default business profile
      await Business.create({
        sellerId: user._id.toString(),
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
      });

      const token = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
      const seller = user.toJSON();

      logger.info('Seller registered successfully (DB):', { id: user._id.toString(), email: user.email });
      return { token, seller };
    }

    // In-memory fallback
    if (memoryUsers.has(cleanEmail)) {
      const err = new Error('Email already registered');
      err.statusCode = 409;
      throw err;
    }

    const userId = 'seller_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    const memUser = {
      id: userId,
      _id: userId,
      businessName: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      password: passwordHash,
      role: defaultRole,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    memoryUsers.set(userId, memUser);
    memoryUsers.set(cleanEmail, memUser);

    const memBusiness = {
      id: 'biz_' + userId,
      sellerId: userId,
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      location: '',
      description: '',
      deliveryInfo: 'Lagos 1-2 days, outside Lagos 2-4 days',
      deliveryFee: 1500,
      deliveryTime: '1-3 days',
      freeDeliveryThreshold: 25000,
      paymentMethod: 'both',
      paystackEnabled: true,
      whatsappConnected: false,
      createdAt: now,
      updatedAt: now,
    };
    memoryBusinesses.set(userId, memBusiness);

    const token = generateToken({ id: userId, email: cleanEmail, role: defaultRole });
    const { password: _p, _id: _i, ...seller } = memUser;

    logger.info('Seller registered successfully (Memory):', { id: userId, email: cleanEmail });
    return { token, seller };
  },

  /**
   * Log in an existing seller
   */
  async login({ email, password }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      const err = new Error('Email and password are required');
      err.statusCode = 400;
      throw err;
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email: cleanEmail }).select('+password');
      if (!user) {
        const err = new Error('Invalid email or password');
        err.statusCode = 401;
        throw err;
      }

      const isMatch = await user.matchPassword(password);
      if (!isMatch) {
        const err = new Error('Invalid email or password');
        err.statusCode = 401;
        throw err;
      }

      if (user.isActive === false) {
        const err = new Error('Account suspended. Contact platform support.');
        err.statusCode = 403;
        throw err;
      }

      const token = generateToken({ id: user._id.toString(), email: user.email, role: user.role });
      const seller = user.toJSON();

      logger.info('Seller logged in (DB):', { id: user._id.toString(), email: user.email });
      return { token, seller };
    }

    // In-memory fallback
    const memUser = memoryUsers.get(cleanEmail);
    if (!memUser) {
      const err = new Error('Invalid email or password');
      err.statusCode = 401;
      throw err;
    }

    const isMatch = await bcrypt.compare(password, memUser.password);
    if (!isMatch) {
      const err = new Error('Invalid email or password');
      err.statusCode = 401;
      throw err;
    }

    if (memUser.isActive === false) {
      const err = new Error('Account suspended. Contact platform support.');
      err.statusCode = 403;
      throw err;
    }

    const token = generateToken({ id: memUser.id, email: memUser.email, role: memUser.role });
    const { password: _p, _id: _i, ...seller } = memUser;

    logger.info('Seller logged in (Memory):', { id: memUser.id, email: memUser.email });
    return { token, seller };
  },

  /**
   * Retrieve current authenticated user profile
   */
  async getMe(userId) {
    if (isDbConnected()) {
      const user = await User.findById(userId);
      if (!user) {
        const err = new Error('Seller not found');
        err.statusCode = 404;
        throw err;
      }
      return user.toJSON();
    }

    const memUser = memoryUsers.get(userId);
    if (!memUser) {
      const err = new Error('Seller not found');
      err.statusCode = 404;
      throw err;
    }

    const { password: _p, _id: _i, ...seller } = memUser;
    return seller;
  },

  /**
   * Find user by ID (for auth middleware)
   */
  async findUserById(userId) {
    if (isDbConnected()) {
      return User.findById(userId);
    }
    const memUser = memoryUsers.get(userId);
    if (!memUser) return null;
    const { password: _p, ...user } = memUser;
    return user;
  },

  /**
   * Memory store helpers for business service & tests
   */
  getMemoryStore() {
    return { users: memoryUsers, businesses: memoryBusinesses };
  },
};

module.exports = authService;
