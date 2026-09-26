/**
 * Payment / Transaction Mongoose Model
 * Tracks revenue splitting: order amount, platform commission fee, seller earnings, and Paystack processor fee
 */

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    orderId: {
      type: String,
      required: [true, 'Order ID is required'],
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    platformFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    sellerAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paystackFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'abandoned'],
      default: 'pending',
      index: true,
    },
    channel: {
      type: String,
      default: 'paystack',
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    idempotencyKey: {
      type: String,
      index: true,
      sparse: true,
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

paymentSchema.index({ sellerId: 1, createdAt: -1 });
paymentSchema.index({ sellerId: 1, status: 1 });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
