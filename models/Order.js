/**
 * Order Mongoose Model
 * Stores frozen item price snapshots, status transitions, and delivery details
 */

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
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
    customerWhatsappId: {
      type: String,
      trim: true,
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
    paymentReference: {
      type: String,
      trim: true,
      default: '',
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

// High performance compound indexes
orderSchema.index({ sellerId: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, orderStatus: 1 });
orderSchema.index({ sellerId: 1, paymentStatus: 1 });

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
