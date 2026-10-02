/**
 * Admin Broadcast Controller
 * Bulk announcement email from the platform to its sellers.
 */

const adminBroadcastService = require('../services/broadcasts/adminBroadcastService');

function actorFrom(req) {
  return {
    id: req.sellerId,
    email: req.user ? req.user.email : '',
    businessName: req.user ? req.user.businessName : '',
  };
}

const broadcastController = {
  /**
   * @route   POST /api/admin/broadcasts/preview
   * @desc    Resolve an audience without sending: count + sample
   */
  async preview(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.preview(req.body || {}));
    } catch (error) {
      next(error);
    }
  },

  /** @route POST /api/admin/broadcasts */
  async create(req, res, next) {
    try {
      const broadcast = await adminBroadcastService.create(req.body || {}, actorFrom(req));
      res.status(201).json(broadcast);
    } catch (error) {
      next(error);
    }
  },

  /** @route GET /api/admin/broadcasts */
  async list(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.list({ limit: req.query.limit }));
    } catch (error) {
      next(error);
    }
  },

  /** @route GET /api/admin/broadcasts/:id */
  async getById(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.getById(req.params.id));
    } catch (error) {
      next(error);
    }
  },

  /** @route PATCH /api/admin/broadcasts/:id */
  async update(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.update(req.params.id, req.body || {}));
    } catch (error) {
      next(error);
    }
  },

  /** @route DELETE /api/admin/broadcasts/:id */
  async remove(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.remove(req.params.id));
    } catch (error) {
      next(error);
    }
  },

  /** @route POST /api/admin/broadcasts/:id/test */
  async sendTest(req, res, next) {
    try {
      res.status(200).json(await adminBroadcastService.sendTest(req.params.id, actorFrom(req)));
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/admin/broadcasts/:id/send
   * @desc    Snapshot the audience and start delivering in the background.
   *          202: the work outlives this request by design.
   */
  async send(req, res, next) {
    try {
      res.status(202).json(await adminBroadcastService.send(req.params.id));
    } catch (error) {
      next(error);
    }
  },

  /** @route POST /api/admin/broadcasts/:id/retry-failed */
  async retryFailed(req, res, next) {
    try {
      res.status(202).json(await adminBroadcastService.retryFailed(req.params.id));
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/broadcasts/unsubscribe
   * @desc    One-click opt-out. PUBLIC: an opt-out link that requires a login
   *          is not a working opt-out.
   */
  async unsubscribe(req, res, next) {
    try {
      const token = req.body.token || req.query.t || '';
      res.status(200).json(await adminBroadcastService.unsubscribe(token));
    } catch (error) {
      next(error);
    }
  },

  /** @route POST /api/broadcasts/resubscribe */
  async resubscribe(req, res, next) {
    try {
      const token = req.body.token || req.query.t || '';
      res.status(200).json(await adminBroadcastService.resubscribe(token));
    } catch (error) {
      next(error);
    }
  },
};

module.exports = broadcastController;
