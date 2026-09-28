/**
 * Shopper Authentication Challenge Model
 *
 * Backs both buyer login paths:
 *   - purpose 'otp'   -> 6 digit code sent through Brevo email
 *   - purpose 'magic' -> single-use link embedded in an order email
 *
 * Only a hash of the secret is ever stored, and documents self-destruct through
 * a TTL index on `expiresAt`.
 */

const mongoose = require('mongoose');

const shopperAuthTokenSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // The exact destination whose control this challenge proves. It is part of
    // the claim boundary: verification never grants access to rows sharing only
    // a phone number.
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    purpose: {
      type: String,
      enum: ['otp', 'magic'],
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    sellerId: {
      type: String,
      default: '',
    },
    orderId: {
      type: String,
      default: '',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        delete ret.tokenHash;
        return ret;
      },
    },
  }
);

shopperAuthTokenSchema.index({ phone: 1, email: 1, purpose: 1, createdAt: -1 });
// Expire challenges automatically once `expiresAt` passes
shopperAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ShopperAuthToken = mongoose.model('ShopperAuthToken', shopperAuthTokenSchema);

module.exports = ShopperAuthToken;
