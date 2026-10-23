'use strict';

/**
 * Marketplace assistant controller.
 *
 * Thin by design: identity comes from middleware (`req.shopperId`,
 * `req.visitorId`), never from the request body. The visitor id is a
 * capability — accepting one from the body would let anyone replay another
 * shopper's id and read their conversation.
 */

const marketplaceChatService = require('../services/ai/marketplaceChatService');

const marketplaceChatController = {
  /**
   * @route   GET /api/chat
   * @desc    Widget bootstrap: title and any restored transcript
   * @access  Public
   */
  async open(req, res, next) {
    try {
      const payload = await marketplaceChatService.open({
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
      });
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/chat
   * @desc    One conversational turn across the whole marketplace
   * @access  Public
   */
  async send(req, res, next) {
    try {
      const payload = await marketplaceChatService.send({
        body: req.body.body,
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
        // Only ever used to offer a "narrow to this store" shortcut.
        storeContext: req.body.storeContext || '',
      });
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   DELETE /api/chat
   * @desc    Forget this shopper's conversation
   * @access  Public
   */
  async clear(req, res, next) {
    try {
      const ownerKey = marketplaceChatService.ownerKeyFor({
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
      });
      await marketplaceChatService.clear(ownerKey);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = marketplaceChatController;
