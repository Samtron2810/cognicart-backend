/**
 * Cloudinary Media Storage Helper Utilities
 */

const cloudinary = require('../config/cloudinary');
const logger = require('./logger');

/** True only when every Cloudinary credential is present. */
function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Produce a short-lived signature for a browser-side (direct) upload.
 *
 * The browser never sees the API secret: it receives only the signature over
 * the exact parameter set the server chose. Cloudinary rejects the upload if
 * the browser alters any signed parameter, which is what stops a seller from
 * writing outside their own folder.
 *
 * @param {Object} paramsToSign - exact params the client must send back
 * @returns {{ signature: string, timestamp: number, apiKey: string, cloudName: string }}
 */
function signUploadParams(paramsToSign) {
  if (!isCloudinaryConfigured()) {
    const err = new Error('Image uploads are unavailable: Cloudinary is not configured on the server');
    err.statusCode = 503;
    throw err;
  }

  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);

  return {
    signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
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
  deleteFromCloudinary,
  signUploadParams,
  isCloudinaryConfigured,
};
