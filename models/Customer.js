/**
 * Customer Mongoose Model
 * Maintains multi-tenant customer profiles, delivery addresses, and purchasing aggregates
 */

const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
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
      required: [true, 'Phone number is required'],
      trim: true,
      index: true,
    },
    whatsappId: {
      type: String,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
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
customerSchema.index({ sellerId: 1, lastOrderAt: -1 });

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
