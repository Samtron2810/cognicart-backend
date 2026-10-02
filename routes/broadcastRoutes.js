/**
 * Admin Broadcast Routes
 *
 * Mounted under /api/admin/broadcasts, which already enforces authentication,
 * a verified email, and the admin/platform_owner role at the router level.
 */

const express = require('express');
const router = express.Router();
const broadcastController = require('../controllers/broadcastController');
const { apiLimiter } = require('../middleware/rateLimiter');

router.post('/preview', broadcastController.preview);
router.get('/', broadcastController.list);
router.post('/', apiLimiter, broadcastController.create);
router.get('/:id', broadcastController.getById);
router.patch('/:id', broadcastController.update);
router.delete('/:id', broadcastController.remove);
router.post('/:id/test', apiLimiter, broadcastController.sendTest);
// Sending can reach every seller on the platform: rate limited on purpose.
router.post('/:id/send', apiLimiter, broadcastController.send);
router.post('/:id/retry-failed', apiLimiter, broadcastController.retryFailed);

module.exports = router;
