/**
 * Order Mongoose Model
 * Stores frozen item price snapshots, status transitions, and delivery details
 */

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    // Optional: manually logged orders may contain items that were never
    // listed in the catalog (a bespoke piece sold over Instagram DM, say).
    // Automatic orders always carry a productId - orderService enforces it.
    productId: { type: String },
    isCustomItem: { type: Boolean, default: false },
    variantId: { type: String },
    variantLabel: { type: String },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    image: { type: String, default: '' },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/**
 * Where the order came from.
 *
 * 'storefront' and 'telegram' are automatic: the system computed the prices
 * and the buyer is the one who placed it. 'manual' orders were typed in by the
 * seller after selling somewhere we have no integration with, so the seller is
 * the authority on price and payment. That distinction drives the guards in
 * manualOrderService and the payment-verification service.
 */
const ORDER_SOURCES = ['storefront', 'telegram', 'manual'];
const AUTOMATIC_SOURCES = ['storefront', 'telegram'];

/** Where a manually logged order was actually taken. Display/reporting only. */
const MANUAL_CHANNELS = [
  'whatsapp',
  'instagram',
  'facebook',
  'tiktok',
  'x',
  'snapchat',
  'phone_call',
  'sms',
  'email',
  'walk_in',
  'referral',
  'other',
];

const PAYMENT_METHODS = ['paystack', 'cash', 'bank_transfer', 'pos', 'other'];

const orderSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    customerId: {
      type: String,
      required: [true, 'Customer ID is required'],
      index: true,
    },
    // Set when the buyer checked out with a verified shopper session, or
    // claimed the exact phone+email pair through buyer verification.
    shopperId: {
      type: String,
      default: null,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    // Snapshot used for Brevo receipts and status updates. Keeping it on the
    // order means later customer-profile edits do not reroute old purchases.
    customerEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      maxlength: [254, 'Customer email cannot exceed 254 characters'],
      validate: {
        validator: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        message: 'Customer email must be valid',
      },
    },
    // --- Provenance -------------------------------------------------------
    source: {
      type: String,
      enum: ORDER_SOURCES,
      default: 'storefront',
      required: true,
      index: true,
    },
    // Only meaningful when source === 'manual'
    sourceChannel: {
      type: String,
      enum: [...MANUAL_CHANNELS, ''],
      default: '',
    },
    // Automatic channel identity. Telegram notifications and AI ownership use
    // this pair instead of treating a numeric Telegram id as a phone number.
    channel: {
      type: String,
      enum: ['storefront', 'telegram', ''],
      default: '',
    },
    channelAccountId: { type: String, default: '', trim: true },
    channelUserId: { type: String, default: '', trim: true },
    channelUsername: { type: String, default: '', trim: true },
    // Free text context, e.g. "DM from @adaobi_thrifts"
    sourceNote: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    // Seller user id that typed this order in; empty for automatic orders
    enteredBy: {
      type: String,
      default: '',
      trim: true,
    },
    // Human-quotable sequential reference, unique per seller (#00124).
    // ObjectIds are unusable when a merchant is on the phone to a customer.
    orderNumber: {
      type: Number,
    },
    deliveryAddress: {
      type: String,
      default: '',
      trim: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: [(val) => val.length > 0, 'An order must contain at least one item'],
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    deliveryFee: {
      type: Number,
      default: 1500,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: ['Pending', 'Paid', 'Failed', 'Refunded'],
      default: 'Pending',
      index: true,
    },
    orderStatus: {
      type: String,
      enum: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'],
      default: 'Pending',
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHODS,
      default: 'paystack',
    },
    paymentReference: {
      type: String,
      trim: true,
      default: '',
    },
    paidAt: {
      type: Date,
      default: null,
    },
    // Ordaflow's "forgetting a customer's delivery date" pain point
    expectedDeliveryDate: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: String,
      enum: ['buyer', 'seller', 'system', ''],
      default: '',
    },
    cancellationReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    // Automatic orders reserve stock at creation. Cancellation restores it
    // exactly once; this timestamp records restoration work in progress.
    inventoryRestoredAt: {
      type: Date,
      default: null,
    },
    inventoryRestoreClaimedAt: {
      type: Date,
      default: null,
      select: false,
    },
    // Whether catalog inventory was deducted for this manually logged order.
    // Automatic orders always reserve stock and do not need this flag.
    inventoryAdjusted: {
      type: Boolean,
      default: false,
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
        // Zero-padded reference the seller can read out loud: #00124
        ret.reference = ret.orderNumber ? `#${String(ret.orderNumber).padStart(5, '0')}` : '';
        ret.isManual = ret.source === 'manual';
        delete ret._id;
        delete ret.__v;
        delete ret.inventoryRestoreClaimedAt;
        return ret;
      },
    },
  }
);

// High performance compound indexes
orderSchema.index({ sellerId: 1, createdAt: -1 });
// Buyer-facing order history lookups
orderSchema.index({ shopperId: 1, createdAt: -1 });
orderSchema.index({ customerPhone: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, orderStatus: 1 });
orderSchema.index({ sellerId: 1, paymentStatus: 1 });
// Dashboard splits automatic vs manually logged orders
orderSchema.index({ sellerId: 1, source: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, channel: 1, channelUserId: 1, createdAt: -1 });
// Human-quotable reference lookup; sparse because legacy rows have none
orderSchema.index({ sellerId: 1, orderNumber: -1 }, { unique: true, sparse: true });

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
module.exports.ORDER_SOURCES = ORDER_SOURCES;
module.exports.AUTOMATIC_SOURCES = AUTOMATIC_SOURCES;
module.exports.MANUAL_CHANNELS = MANUAL_CHANNELS;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
