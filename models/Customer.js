/**
 * Customer Mongoose Model
 * Maintains multi-tenant customer profiles, delivery addresses, and purchasing aggregates
 */

const mongoose = require('mongoose');

const channelIdentitySchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['telegram'], required: true },
    externalId: { type: String, required: true, trim: true },
    handle: { type: String, default: '', trim: true },
    displayName: { type: String, default: '', trim: true },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    // Links this per-seller CRM record to the global email-verified buyer identity
    shopperId: {
      type: String,
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      maxlength: [100, 'Customer name cannot exceed 100 characters'],
    },
    phone: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    identities: {
      type: [channelIdentitySchema],
      default: [],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      maxlength: [254, 'Email cannot exceed 254 characters'],
      validate: {
        validator: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        message: 'Email must be valid',
      },
    },
    addresses: {
      type: [String],
      default: [],
    },
    totalOrders: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalSpent: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastOrderAt: {
      type: Date,
      default: null,
    },
    marketingOptOut: {
      type: Boolean,
      default: false,
      index: true,
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

// Compound index for fast lookup of a customer under a specific seller
customerSchema.index({ sellerId: 1, phone: 1 });
customerSchema.index(
  { sellerId: 1, phone: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      phone: { $type: 'string', $gt: '' },
      email: { $type: 'string', $gt: '' },
    },
  }
);
customerSchema.index(
  { sellerId: 1, 'identities.channel': 1, 'identities.externalId': 1 },
  { unique: true }
);
customerSchema.index({ sellerId: 1, lastOrderAt: -1 });

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
