/**
 * Order Group Mongoose Model — the parent of a multi-seller checkout.
 *
 * Every `Order` in this system is already single-seller: `sellerId` is
 * required and `orderNumber` is unique per seller. An Order *is* the
 * sub-order. What was missing was the thing above them — the basket the buyer
 * actually paid for, spanning several stores in one transaction.
 *
 * So this document owns exactly three things the sub-orders cannot:
 *   1. the grand total the buyer was charged,
 *   2. the single payment reference covering all of it,
 *   3. the fan-out state, so a webhook retry cannot pay a seller twice.
 *
 * Deliberately NOT here: items, prices, stock, status. Those stay on the
 * sub-orders, which means the seller dashboard, payouts and analytics keep
 * working untouched — they filter by `sellerId` and will only ever see their
 * own slice. A seller can never read the grand total or another store's items.
 */

const mongoose = require('mongoose');

/** Per-seller line in the parent. A pointer plus the money, nothing more. */
const groupOrderSchema = new mongoose.Schema(
  {
    sellerId: { type: String, required: true },
    orderId: { type: String, required: true },
    // Human-readable suffix: ORD-1042-A, ORD-1042-B. Assigned in cart order so
    // it is stable and quotable on the phone.
    label: { type: String, required: true },
    storeName: { type: String, default: '' },
    subtotal: { type: Number, required: true, min: 0 },
    // Each seller sets their own delivery fee, so three stores legitimately
    // means three fees. The breakdown is kept so it can be shown, not buried.
    deliveryFee: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    // Set once the group payment has been fanned out to this sub-order.
    // The guard against double-crediting a seller on a webhook retry.
    settledAt: { type: Date, default: null },
    paymentReference: { type: String, default: '' },
  },
  { _id: false }
);

const GROUP_PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Partially Settled'];

const orderGroupSchema = new mongoose.Schema(
  {
    // Quotable parent reference: ORD-1042. Sub-orders append -A, -B, -C.
    groupNumber: {
      type: Number,
      required: true,
      unique: true, // `unique` already builds the index
    },
    shopperId: { type: String, default: null, index: true },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    customerEmail: { type: String, default: '', trim: true, lowercase: true },
    deliveryAddress: { type: String, default: '', trim: true },

    orders: {
      type: [groupOrderSchema],
      required: true,
      validate: [(value) => value.length > 0, 'An order group must contain at least one sub-order'],
    },
    // Denormalised for the "which stores did I buy from" query.
    sellerIds: { type: [String], default: [], index: true },

    subtotal: { type: Number, required: true, min: 0 },
    deliveryTotal: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'NGN' },

    // The one Paystack transaction covering every sub-order.
    paymentReference: { type: String, default: '', index: true },
    authorizationUrl: { type: String, default: '' },
    paymentStatus: {
      type: String,
      enum: GROUP_PAYMENT_STATUSES,
      default: 'Pending',
      index: true,
    },
    paidAt: { type: Date, default: null },
    // Held while a fan-out is in flight, so a webhook and a callback landing
    // at the same instant cannot both settle the group.
    settlementClaimedAt: { type: Date, default: null, select: false },
    settledAt: { type: Date, default: null },

    source: { type: String, default: 'storefront' },
    idempotencyKey: { type: String, index: true, sparse: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        ret.reference = ret.groupNumber ? `ORD-${ret.groupNumber}` : '';
        delete ret._id;
        delete ret.__v;
        delete ret.settlementClaimedAt;
        return ret;
      },
    },
  }
);

orderGroupSchema.index({ customerEmail: 1, createdAt: -1 });
orderGroupSchema.index({ shopperId: 1, createdAt: -1 });

const OrderGroup = mongoose.model('OrderGroup', orderGroupSchema);

module.exports = OrderGroup;
module.exports.GROUP_PAYMENT_STATUSES = GROUP_PAYMENT_STATUSES;
