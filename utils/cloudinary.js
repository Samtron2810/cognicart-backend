/**
 * Cloudinary Media Storage Helper Utilities
 */

const cloudinary = require('../config/cloudinary');
const logger = require('./logger');

/**
 * Upload a media file buffer or base64 string to Cloudinary
 * @param {Buffer|string} fileSource - File buffer or data URI
 * @param {Object} options - Upload options (folder, tags, transformations)
 * @returns {Promise<{ url: string, public_id: string }>}
 */
async function uploadToCloudinary(fileSource, options = {}) {
  const isConfigured = !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );

  if (!isConfigured) {
    logger.warn('Cloudinary not configured. Using deterministic mock asset URL.');
    const mockId = 'mock_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return {
      url: `https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&h=600&fit=crop&q=80`,
      public_id: `wabac/products/${mockId}`,
    };
  }

  const defaultOptions = {
    folder: 'wabac/products',
    resource_type: 'auto',
    ...options,
  };

  if (Buffer.isBuffer(fileSource)) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(defaultOptions, (error, result) => {
        if (error) {
          logger.error('Cloudinary stream upload error:', { error: error.message });
          return reject(error);
        }
        resolve({
          url: result.secure_url || result.url,
          public_id: result.public_id,
        });
      });
      stream.end(fileSource);
    });
  }

  // Base64 or string URL
  const result = await cloudinary.uploader.upload(fileSource, defaultOptions);
  return {
    url: result.secure_url || result.url,
    public_id: result.public_id,
  };
}

/**
 * Delete a media asset from Cloudinary
 * @param {string} publicId - Asset public_id
 */
async function deleteFromCloudinary(publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    logger.warn('Error deleting Cloudinary asset:', { publicId, error: error.message });
  }
}

module.exports = {
  uploadToCloudinary,
  deleteFromCloudinary,
};
