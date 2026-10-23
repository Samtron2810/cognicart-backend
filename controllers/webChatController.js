/**
 * Per-Store Website Chatbot Controller
 *
 * Every handler resolves the tenant from the store in the URL. `sellerId` is
 * never read from the request body: that is the single control that stops a
 * crafted request pointing one store's chat widget at another store's data.
 */

const webChatService = require('../services/ai/webChatService');
const storefrontService = require('../services/storefront/storefrontService');

/**
 * Resolve :identifier (slug or sellerId) to a tenant.
 * `resolveStore` already throws a 404 for an unknown store, which is the
 * behaviour we want: the chat widget must never silently fall back to some
 * other seller's data.
 */
async function resolveSellerId(identifier) {
  const profile = await storefrontService.resolveStore(identifier);
  if (!profile || !profile.sellerId) {
    const err = new Error('Store not found');
    err.statusCode = 404;
    throw err;
  }
  return profile.sellerId;
}

const webChatController = {
  /**
   * @route   GET /api/storefront/:identifier/chat
   * @desc    Widget bootstrap: store name, title, restored transcript
   * @access  Public
   */
  async open(req, res, next) {
    try {
      const sellerId = await resolveSellerId(req.params.identifier);
      const payload = await webChatService.open({
        sellerId,
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
      });
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/storefront/:identifier/chat
   * @desc    One conversational turn with this store's bot
   * @access  Public
   */
  async send(req, res, next) {
    try {
      const sellerId = await resolveSellerId(req.params.identifier);
      const result = await webChatService.send({
        sellerId,
        body: req.body.body,
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
        customerName: (req.shopper && req.shopper.name) || req.body.customerName || '',
        customerEmail: (req.shopper && req.shopper.email) || req.body.customerEmail || '',
        customerPhone: (req.shopper && req.shopper.phone) || req.body.customerPhone || '',
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   DELETE /api/storefront/:identifier/chat
   * @desc    Buyer clears their own conversation with this store
   * @access  Public
   */
  async clear(req, res, next) {
    try {
      const sellerId = await resolveSellerId(req.params.identifier);
      const ownerKey = webChatService.ownerKeyFor({
        shopperId: req.shopperId || null,
        visitorId: req.visitorId || '',
      });
      await webChatService.clear(sellerId, ownerKey);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = webChatController;
