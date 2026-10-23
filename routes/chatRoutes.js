'use strict';

/**
 * Marketplace assistant routes.
 *
 * Mounted at /api/chat — deliberately NOT under /storefront/:identifier,
 * because this assistant is not scoped to a store. It is available from
 * every public page.
 *
 * `attachVisitor` gives an anonymous shopper a signed, httpOnly identity so
 * their conversation survives a reload without that identity being forgeable.
 * `optionalShopper` upgrades the owner to a verified shopper when one is
 * signed in, so the transcript follows them across devices.
 */

const express = require('express');

const chatController = require('../controllers/marketplaceChatController');
const { attachVisitor } = require('../middleware/visitorMiddleware');
const { optionalShopper } = require('../middleware/shopperMiddleware');

const router = express.Router();

router.get('/', attachVisitor, optionalShopper, chatController.open);
router.post('/', attachVisitor, optionalShopper, chatController.send);
router.delete('/', attachVisitor, optionalShopper, chatController.clear);

module.exports = router;
