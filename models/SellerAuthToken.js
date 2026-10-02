/**
 * Seller Authentication Challenge Model
 *
 * Backs two seller-account email flows:
 *   - purpose 'verify_email'   -> 6 digit one-time code sent after registration
 *   - purpose 'reset_password' -> single-use link sent from "Forgot password"
 *
 * Only a hash of the raw secret is ever stored (for codes the hash covers
 * `email:code`, so a code is worthless against a different address), and
 * documents self-destruct through a TTL index on `expiresAt`. Mirrors the
 * ShopperAuthToken pattern.
 */

const mongoose = require('mongoose');

const sellerAuthTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    purpose: {
      type: String,
      enum: ['verify_email', 'reset_password'],
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    // Brute-force budget for the 'verify_email' code challenge. Unused by the
    // link-based 'reset_password' purpose.
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

sellerAuthTokenSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
// Expire challenges automatically once `expiresAt` passes
sellerAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SellerAuthToken = mongoose.model('SellerAuthToken', sellerAuthTokenSchema);

module.exports = SellerAuthToken;
