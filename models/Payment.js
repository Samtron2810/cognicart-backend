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
      unique: true, // `unique` already builds the index
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
    authorizationUrl: {
      type: String,
      default: '',
      trim: true,
    },
    accessCode: {
      type: String,
      default: '',
      trim: true,
      select: false,
    },
    providerTransactionId: {
      type: String,
      default: '',
      trim: true,
    },
    providerStatus: {
      type: String,
      default: '',
      trim: true,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
    refundStatus: {
      type: String,
      enum: ['none', 'pending', 'processed', 'failed'],
      default: 'none',
    },
    refundId: {
      type: String,
      default: '',
      trim: true,
    },
    refundReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    idempotencyKey: {
      type: String,
      default: undefined,
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
        delete ret.accessCode;
        return ret;
      },
    },
  }
);

paymentSchema.index({ sellerId: 1, createdAt: -1 });
paymentSchema.index({ sellerId: 1, status: 1 });
paymentSchema.index({ orderId: 1, createdAt: -1 });
paymentSchema.index(
  { orderId: 1 },
  {
    name: 'unique_pending_payment_per_order',
    unique: true,
    partialFilterExpression: { status: 'pending' },
  }
);
paymentSchema.index(
  { sellerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
