/**
 * Public Unsubscribe Routes
 *
 * Deliberately unauthenticated: a one-click opt-out link that demands a login
 * is not a compliant opt-out. The token is an HMAC over the user id, and the
 * response is generic so the endpoint cannot be used to probe for accounts.
 */

const express = require('express');
const router = express.Router();
const broadcastController = require('../controllers/broadcastController');
const { authLimiter } = require('../middleware/rateLimiter');

router.post('/unsubscribe', authLimiter, broadcastController.unsubscribe);
router.post('/resubscribe', authLimiter, broadcastController.resubscribe);

module.exports = router;
