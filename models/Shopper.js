/**
 * Shopper (Buyer) Mongoose Model
 *
 * Global, phone-keyed buyer identity. Deliberately credential-free: a shopper
 * proves access through a Brevo email magic link or one-time code (and later an
 * already-linked Telegram chat), never with a password. Email is the unique
 * identity for storefront verification; phone remains a contact attribute.
 * The Shopper then links to explicitly claimed per-seller Customer records.
 */

const mongoose = require('mongoose');

const shopperSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      index: true,
    },
    name: {
      type: String,
      default: '',
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      maxlength: [254, 'Email cannot exceed 254 characters'],
      validate: {
        validator: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        message: 'Email must be valid',
      },
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
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
        return ret;
      },
    },
  }
);

const Shopper = mongoose.model('Shopper', shopperSchema);

module.exports = Shopper;
