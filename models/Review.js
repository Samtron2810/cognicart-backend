/**
 * Seller Review Mongoose Model
 *
 * Reviews rate a *seller*, not a product. The marketplace is seller-first:
 * the directory ranks stores, and a buyer picks a store before they pick an
 * item, so the rating that matters is the store's.
 *
 * The integrity rule is in the unique index rather than in application code:
 * one review per buyer per order. Combined with the delivered-order check in
 * reviewService, that means a review cannot exist without a completed
 * purchase behind it, and a buyer cannot stack ten reviews onto one order.
 * Ratings that are trivial to fake are worse than no ratings at all, because
 * they look authoritative.
 */

const mongoose = require('mongoose');

const REVIEW_STATUSES = ['published', 'hidden'];

const reviewSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required'],
      index: true,
    },
    // The verified buyer who wrote it.
    shopperId: {
      type: String,
      required: [true, 'Shopper ID is required'],
      index: true,
    },
    // The delivered order that earns the right to review. Keeping it on the
    // document means "verified purchase" is provable after the fact, not just
    // asserted at write time.
    orderId: {
      type: String,
      required: [true, 'Order ID is required'],
    },
    // Snapshot: a later profile edit must not rewrite the name on an old review.
    buyerName: {
      type: String,
      default: 'Verified buyer',
      trim: true,
      maxlength: 80,
    },
    rating: {
      type: Number,
      required: [true, 'Rating is required'],
      min: [1, 'Rating must be between 1 and 5'],
      max: [5, 'Rating must be between 1 and 5'],
      validate: {
        validator: Number.isInteger,
        message: 'Rating must be a whole number between 1 and 5',
      },
    },
    comment: {
      type: String,
      default: '',
      trim: true,
      maxlength: [1000, 'Review cannot exceed 1000 characters'],
    },
    // A seller may answer once, publicly. Replies cannot change the score.
    sellerReply: {
      text: { type: String, default: '', trim: true, maxlength: 1000 },
      repliedAt: { type: Date, default: null },
    },
    // Moderation. Hidden reviews stay in the database and still belong to
    // their order, so hiding one cannot be used to free up a second attempt.
    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: 'published',
      index: true,
    },
    hiddenReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
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
        // Never leak which buyer account wrote a review to the public list.
        delete ret.shopperId;
        return ret;
      },
    },
  }
);

// Public store page: published reviews, newest first.
reviewSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
// One review per buyer per order. This is the anti-gaming guarantee.
reviewSchema.index({ shopperId: 1, orderId: 1 }, { unique: true });

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;
module.exports.REVIEW_STATUSES = REVIEW_STATUSES;
