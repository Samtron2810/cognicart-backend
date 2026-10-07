/**
 * Direct (Signed) Upload Controller
 *
 * Issues short-lived Cloudinary signatures so the browser can upload image
 * bytes straight to Cloudinary. Image data never transits this API.
 *
 * Security model: the SERVER chooses every signed parameter - folder, tags and
 * the upload timestamp. The browser may not alter them, because Cloudinary
 * recomputes the signature over exactly these values and rejects a mismatch.
 * That is what prevents one seller from writing into another's folder.
 */

const { signUploadParams } = require('../utils/cloudinary');

/** Signature lifetime is enforced by Cloudinary against `timestamp`. */
const UPLOAD_FOLDERS = {
  logo: (sellerId) => `chatstand/sellers/${sellerId}/branding`,
  product: (sellerId) => `chatstand/products/${sellerId}`,
};

const uploadController = {
  /**
   * @route   POST /api/uploads/signature
   * @desc    Issue a signed, scoped Cloudinary upload ticket
   * @access  Private (verified seller)
   */
  async createUploadSignature(req, res, next) {
    try {
      const kind = String(req.body.kind || 'product');

      const folderFor = UPLOAD_FOLDERS[kind];
      if (!folderFor) {
        return res.status(400).json({
          success: false,
          message: `Invalid upload kind "${kind}". Allowed: ${Object.keys(UPLOAD_FOLDERS).join(', ')}`,
        });
      }

      const folder = folderFor(req.sellerId);
      const timestamp = Math.round(Date.now() / 1000);

      // Only these params are signed, so only these may be sent by the client
      // (besides file + api_key + timestamp + signature itself).
      const paramsToSign = {
        folder,
        timestamp,
        tags: `seller_${req.sellerId},${kind}`,
      };

      const { signature, apiKey, cloudName } = signUploadParams(paramsToSign);

      res.status(200).json({
        success: true,
        cloudName,
        apiKey,
        timestamp,
        signature,
        folder,
        tags: paramsToSign.tags,
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = uploadController;
