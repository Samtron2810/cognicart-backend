/**
 * Business Profile Service
 * Manages seller business settings, delivery parameters, bank info, and public share contacts
 */

const mongoose = require('mongoose');
const Business = require('../../models/Business');
const User = require('../../models/User');
const logger = require('../../utils/logger');
const { deleteFromCloudinary } = require('../../utils/cloudinary');

/**
 * Base64 data URIs are no longer accepted for media fields: images are
 * uploaded straight to Cloudinary by the browser and only the resulting URL is
 * stored. Rejecting them here keeps a stale client (or a hand-rolled request)
 * from re-introducing multi-megabyte documents.
 */
function rejectDataUri(value, field) {
  if (typeof value === 'string' && value.trim().toLowerCase().startsWith('data:')) {
    const err = new Error(
      `Inline base64 images are not accepted for "${field}". Upload the file to Cloudinary and send its URL.`
    );
    err.statusCode = 400;
    throw err;
  }
}

const UPDATABLE_FIELDS = [
  'name',
  'slug',
  'description',
  'phone',
  'email',
  'location',
  'logo',
  'logoPublicId',
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

    rejectDataUri(payload.logo, 'logo');

    const updates = {};
    for (const field of UPDATABLE_FIELDS) {
      if (payload[field] !== undefined) {
        updates[field] = payload[field];
      }
    }

    // Guarantee the profile exists before patching it
    await this.getBySellerId(sellerId);

    // Capture the outgoing asset before the write so it can be destroyed after.
    let orphanedLogoId = '';
    if (updates.logo !== undefined || updates.logoPublicId !== undefined) {
      const current = await Business.findOne({ sellerId }).select('logo logoPublicId').lean();
      const previousId = current && current.logoPublicId;
      const stillInUse = previousId && updates.logoPublicId === previousId;
      if (previousId && !stillInUse) orphanedLogoId = previousId;
    }

    const business = await Business.findOneAndUpdate(
      { sellerId },
      { $set: updates },
      { new: true, runValidators: true, upsert: true }
    );

    if (orphanedLogoId) {
      // Side effect only: the profile is already saved, so a failed destroy
      // must never fail the request.
      deleteFromCloudinary(orphanedLogoId).catch((error) =>
        logger.warn('Could not delete replaced logo asset:', { sellerId, error: error.message })
      );
    }

    logger.info('Business profile updated:', { sellerId });
    return business.toJSON();
  },
};

module.exports = businessService;
