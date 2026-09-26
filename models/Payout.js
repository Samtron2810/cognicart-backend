/**
 * Payout / Settlement Mongoose Model
 * Tracks seller earnings withdrawals, bank resolution, and disbursement states
 */

const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    amount: {
      type: Number,
      required: [true, 'Payout amount is required'],
      min: [100, 'Minimum payout amount is ₦100'],
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    bankCode: {
      type: String,
      required: [true, 'Bank code is required'],
      trim: true,
    },
    bankName: {
      type: String,
      required: [true, 'Bank name is required'],
      trim: true,
    },
    accountNumber: {
      type: String,
      required: [true, 'Account number is required'],
      trim: true,
    },
    accountName: {
      type: String,
      required: [true, 'Account name is required'],
      trim: true,
    },
    recipientCode: {
      type: String,
      trim: true,
      default: '',
    },
    transferCode: {
      type: String,
      trim: true,
      default: '',
    },
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'success', 'rejected', 'failed'],
      default: 'pending',
      index: true,
    },
    rejectionReason: {
      type: String,
      default: '',
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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

payoutSchema.index({ sellerId: 1, createdAt: -1 });
payoutSchema.index({ status: 1 });

const Payout = mongoose.model('Payout', payoutSchema);

module.exports = Payout;
