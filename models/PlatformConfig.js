/**
 * Platform Configuration Mongoose Model
 * Manages global platform fee percentages and system policies
 */

const mongoose = require('mongoose');

const platformConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'platform_fee',
    },
    percentage: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },
    fixed: {
      type: Number,
      default: 0,
      min: 0,
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

const PlatformConfig = mongoose.model('PlatformConfig', platformConfigSchema);

module.exports = PlatformConfig;
