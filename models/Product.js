/**
 * Product Mongoose Model
 * Supports multi-tenant isolation, variants, discounts, category tagging, and stock tracking
 */

const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema(
  {
    id: { type: String },
    size: { type: String, trim: true },
    color: { type: String, trim: true },
    stock: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    price: { type: Number, min: 0 },
    image: { type: String },
  },
  { _id: false }
);

const discountSchema = new mongoose.Schema(
  {
    active: { type: Boolean, default: false },
    type: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    value: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      minlength: [2, 'Product name must be at least 2 characters'],
      maxlength: [120, 'Product name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [3000, 'Description cannot exceed 3000 characters'],
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    currency: {
      type: String,
      default: 'NGN',
      trim: true,
    },
    stock: {
      type: Number,
      required: [true, 'Stock quantity is required'],
      min: [0, 'Stock cannot be negative'],
    },
    category: {
      type: String,
      default: 'Other',
      trim: true,
      index: true,
    },
    images: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    discount: {
      type: discountSchema,
      default: () => ({ active: false, type: 'percentage', value: 0 }),
    },
    variants: {
      type: [variantSchema],
      default: [],
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

// Compound indexes for multi-tenant high-performance queries
productSchema.index({ sellerId: 1, isActive: 1 });
productSchema.index({ sellerId: 1, category: 1 });
productSchema.index({ sellerId: 1, createdAt: -1 });

/**
 * Calculate effective price accounting for discounts and variant overrides
 */
function getEffectivePrice(product, variant) {
  const base = variant && variant.price !== undefined ? variant.price : product.price;
  if (!product.discount || !product.discount.active) return base;

  if (product.discount.type === 'percentage') {
    return Math.max(0, Math.round(base * (1 - product.discount.value / 100)));
  } else if (product.discount.type === 'fixed') {
    return Math.max(0, Math.round(base - product.discount.value));
  }
  return base;
}

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
module.exports.getEffectivePrice = getEffectivePrice;
