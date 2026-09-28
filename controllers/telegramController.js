const telegramService = require('../services/telegram/telegramService');

const telegramController = {
  async getConfig(req, res, next) {
    try {
      const data = await telegramService.getConfig(req.sellerId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },

  async connect(req, res, next) {
    try {
      const data = await telegramService.connect(req.sellerId, req.body || {});
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },

  async disconnect(req, res, next) {
    try {
      const data = await telegramService.disconnect(req.sellerId);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },

  async listMessages(req, res, next) {
    try {
      const data = await telegramService.listMessages(req.sellerId, {
        channelUserId: req.query.channelUserId,
        direction: req.query.direction,
      });
      res.json({ success: true, count: data.length, data });
    } catch (error) {
      next(error);
    }
  },

  async listConversations(req, res, next) {
    try {
      const data = await telegramService.getConversations(req.sellerId);
      res.json({ success: true, count: data.length, data });
    } catch (error) {
      next(error);
    }
  },

  async webhook(req, res, next) {
    try {
      await telegramService.handleUpdate({
        business: req.telegramBusiness,
        update: req.body || {},
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  },

  async simulate(req, res, next) {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      const config = await telegramService.getConfig(req.sellerId);
      if (!config.botId) {
        return res.status(409).json({ success: false, message: 'Connect a Telegram bot first' });
      }
      const data = await telegramService.handleUpdateForBot(config.botId, req.body || {});
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = telegramController;
