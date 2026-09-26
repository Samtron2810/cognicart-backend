/**
 * Cloudinary Media Storage Configuration
 */

const cloudinary = require('cloudinary').v2;
const logger = require('../utils/logger');

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  logger.info('Cloudinary configured successfully');
} else {
  logger.warn('Cloudinary credentials missing or incomplete. Cloud uploads will fall back to local URLs or mock storage.');
}

module.exports = cloudinary;
