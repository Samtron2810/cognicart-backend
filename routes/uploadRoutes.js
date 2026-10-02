/**
 * Signed Direct-Upload Routes
 * Hands out Cloudinary upload tickets; no image bytes pass through this API.
 */

const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { protect, requireVerifiedEmail } = require('../middleware/authMiddleware');
const { apiLimiter } = require('../middleware/rateLimiter');

router.post('/signature', protect, requireVerifiedEmail, apiLimiter, uploadController.createUploadSignature);

module.exports = router;
