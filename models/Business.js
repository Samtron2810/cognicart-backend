/**
 * Business Profile Mongoose Model
 */

const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: true,
      unique: true, // `unique` already builds the index
    },
    name: {
      type: String,
      required: [true, 'Business name is required'],
      trim: true,
      maxlength: [100, 'Business name cannot exceed 100 characters'],
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      // Unique so two stores can never claim the same /store/<slug> URL.
      // Sparse so businesses created before slugs existed are still valid.
      unique: true,
      sparse: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    location: {
      type: String,
      trim: true,
      default: '',
    },
    logo: {
      type: String,
      default: '',
    },
    // Cloudinary asset id behind `logo`. Kept so replacing or clearing the
    // logo can destroy the previous asset instead of orphaning it.
    logoPublicId: {
      type: String,
      default: '',
    },
    deliveryInfo: {
      type: String,
      default: 'Lagos 1-2 days, outside Lagos 2-4 days',
    },
    deliveryFee: {
      type: Number,
      default: 1500,
      min: [0, 'Delivery fee cannot be negative'],
    },
    deliveryTime: {
      type: String,
      default: '1-3 days',
    },
    freeDeliveryThreshold: {
      type: Number,
      default: 25000,
      min: [0, 'Free delivery threshold cannot be negative'],
    },
    paymentMethod: {
      type: String,
      enum: ['paystack', 'transfer', 'both'],
      default: 'both',
    },
    paystackEnabled: {
      type: Boolean,
      default: true,
    },
    bankName: {
      type: String,
      default: '',
    },
    accountNumber: {
      type: String,
      default: '',
    },
    accountName: {
      type: String,
      default: '',
    },
    // Telegram Bot API connection. Secrets are excluded from every normal query
    // and JSON response; server-side adapters explicitly opt in with select().
    telegramBotId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    telegramBotUsername: {
      type: String,
      default: '',
      trim: true,
    },
    telegramBotToken: {
      type: String,
      trim: true,
      select: false,
    },
    telegramWebhookSecret: {
      type: String,
      trim: true,
      select: false,
    },
    telegramWebhookUrl: {
      type: String,
      default: '',
      trim: true,
    },
    telegramConnected: {
      type: Boolean,
      default: false,
    },
    telegramConnectedAt: {
      type: Date,
      default: null,
    },
    telegramWebhookVerified: {
      type: Boolean,
      default: false,
    },
    // --- Seller directory & ranking (Phase 1) -------------------------
    // Hide a store from /stores without deactivating the account.
    isListed: { type: Boolean, default: true, index: true },
    // Paid placement. Checked against sponsoredUntil before it counts.
    isSponsored: { type: Boolean, default: false },
    sponsoredUntil: { type: Date, default: null },
    // Denormalised so the directory never counts products per card.
    activeProductCount: { type: Number, default: 0, min: 0 },
    // Written by the reviews service; read by the ranking engine.
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    // Cached ranking score, recomputed hourly by the ranking job.
    rankingScore: { type: Number, default: 0, index: true },
    rankingUpdatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        // Never expose Telegram credentials through an API response
        delete ret.telegramBotToken;
        delete ret.telegramWebhookSecret;
        return ret;
      },
    },
  }
);

const Business = mongoose.model('Business', businessSchema);

module.exports = Business;
