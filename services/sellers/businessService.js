/**
 * Business Profile Service
 * Manages seller business settings, delivery parameters, bank info, and public share contacts
 */

const mongoose = require('mongoose');
const Business = require('../../models/Business');
const User = require('../../models/User');
const logger = require('../../utils/logger');

const UPDATABLE_FIELDS = [
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
];

const businessService = {
  /**
   * Get business profile by seller ID.
   * Returns null when neither a profile nor the owning seller exists.
   */
  async getBySellerId(sellerId) {
    if (!sellerId) return null;

    const business = await Business.findOne({ sellerId });
    if (business) return business.toJSON();

    // Lazily create the default profile for a seller that exists but has none yet
    if (!mongoose.isValidObjectId(sellerId)) return null;

    const user = await User.findById(sellerId);
    if (!user) return null;

    const created = await Business.create({
      sellerId,
      name: user.businessName,
      email: user.email,
      phone: user.phone,
    });

    logger.info('Default business profile created:', { sellerId });
    return created.toJSON();
  },

  /**
   * Same as getBySellerId but throws a 404 instead of returning null.
   */
  async requireBySellerId(sellerId) {
    const business = await this.getBySellerId(sellerId);
    if (!business) {
      const err = new Error('Business profile not found');
      err.statusCode = 404;
      throw err;
    }
    return business;
  },

  /**
   * Read the business profile including secret fields (server-side use only).
   */
  async getWithSecrets(sellerId) {
    if (!sellerId) return null;
    const business = await Business.findOne({ sellerId }).select(
      '+telegramBotToken +telegramWebhookSecret'
    );
    return business ? business.toObject() : null;
  },

  /**
   * Update business profile for the authenticated seller
   */
  async update(sellerId, payload = {}) {
    if (!sellerId) {
      const err = new Error('Seller ID is required');
      err.statusCode = 400;
      throw err;
    }

    const updates = {};
    for (const field of UPDATABLE_FIELDS) {
      if (payload[field] !== undefined) {
        updates[field] = payload[field];
      }
    }

    // Guarantee the profile exists before patching it
    await this.getBySellerId(sellerId);

    const business = await Business.findOneAndUpdate(
      { sellerId },
      { $set: updates },
      { new: true, runValidators: true, upsert: true }
    );

    logger.info('Business profile updated:', { sellerId });
    return business.toJSON();
  },
};

module.exports = businessService;
