/**
 * Business Profile Service
 * Manages seller business settings, delivery parameters, bank info, and WhatsApp connection status
 */

const Business = require('../../models/Business');
const User = require('../../models/User');
const { isDbConnected } = require('../../config/db');
const authService = require('../auth/authService');
const logger = require('../../utils/logger');

const businessService = {
  /**
   * Get business profile by seller ID
   */
  async getBySellerId(sellerId) {
    if (isDbConnected()) {
      let business = await Business.findOne({ sellerId });
      if (!business) {
        // Create default business profile if none exists
        const user = await User.findById(sellerId);
        business = await Business.create({
          sellerId,
          name: user ? user.businessName : 'My Store',
          email: user ? user.email : '',
          phone: user ? user.phone : '',
        });
      }
      return business.toJSON();
    }

    // In-memory fallback
    const { businesses, users } = authService.getMemoryStore();
    let business = businesses.get(sellerId);
    if (!business) {
      const user = users.get(sellerId);
      const now = new Date().toISOString();
      business = {
        id: 'biz_' + sellerId,
        sellerId,
        name: user ? user.businessName : 'My Store',
        email: user ? user.email : '',
        phone: user ? user.phone : '',
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
      businesses.set(sellerId, business);
    }
    return business;
  },

  /**
   * Update business profile for the authenticated seller
   */
  async update(sellerId, payload) {
    const allowedFields = [
      'name',
      'slug',
      'description',
      'phone',
      'email',
      'location',
      'logo',
      'deliveryInfo',
      'deliveryFee',
      'deliveryTime',
      'freeDeliveryThreshold',
      'paymentMethod',
      'paystackEnabled',
      'bankName',
      'accountNumber',
      'accountName',
      'whatsappPhone',
      'whatsappConnected',
      'whatsappVerifiedAt',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (payload[field] !== undefined) {
        updates[field] = payload[field];
      }
    }

    if (isDbConnected()) {
      let business = await Business.findOneAndUpdate(
        { sellerId },
        { $set: updates },
        { new: true, runValidators: true, upsert: true }
      );
      logger.info('Business profile updated (DB):', { sellerId });
      return business.toJSON();
    }

    // In-memory fallback
    const { businesses, users } = authService.getMemoryStore();
    let current = businesses.get(sellerId);
    const now = new Date().toISOString();
    if (!current) {
      const user = users.get(sellerId);
      current = {
        id: 'biz_' + sellerId,
        sellerId,
        name: user ? user.businessName : 'My Store',
        email: user ? user.email : '',
        phone: user ? user.phone : '',
        createdAt: now,
      };
    }

    const updated = {
      ...current,
      ...updates,
      updatedAt: now,
    };
    businesses.set(sellerId, updated);
    logger.info('Business profile updated (Memory):', { sellerId });
    return updated;
  },
};

module.exports = businessService;
