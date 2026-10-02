/**
 * Platform Administration & Revenue Controller
 * Manages SaaS owner analytics, revenue distribution, seller account states, and fee policies
 *
 * Performance contract: no admin endpoint may load a whole collection into
 * memory. Counts and sums are computed by MongoDB aggregation, list endpoints
 * are `.lean()` + sorted + bounded, and per-seller rollups are built from
 * `$group` results joined through a Map - never nested `Array.filter` per
 * seller, which was O(sellers x documents).
 */

const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Payment = require('../models/Payment');
const Business = require('../models/Business');
const mongoose = require('mongoose');
const paymentService = require('../services/payments/paymentService');
const payoutService = require('../services/payouts/payoutService');
const notificationService = require('../services/notifications/notificationService');
const logger = require('../utils/logger');

/** Hard ceiling for any list endpoint, so one huge tenant cannot stall the API. */
const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 500;
/** Per-seller detail lists are previews; the dedicated pages own full history. */
const DETAIL_LIMIT = 200;

function parseLimit(value, fallback = DEFAULT_LIST_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

/**
 * `.lean()` skips mongoose hydration (the main cost here) but also skips the
 * schema `toJSON` transforms, so these helpers reproduce them exactly. Getting
 * this wrong would leak credentials, so the omissions are explicit.
 */
function baseSerialize(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  out.id = doc._id ? doc._id.toString() : doc.id;
  delete out._id;
  delete out.__v;
  return out;
}

function serializeUser(doc) {
  const out = baseSerialize(doc);
  if (out) delete out.password;
  return out;
}

function serializeBusiness(doc) {
  const out = baseSerialize(doc);
  if (!out) return out;
  // Never expose Telegram credentials through an API response
  delete out.telegramBotToken;
  delete out.telegramWebhookSecret;
  return out;
}

function serializeOrder(doc) {
  const out = baseSerialize(doc);
  if (!out) return out;
  out.reference = out.orderNumber ? `#${String(out.orderNumber).padStart(5, '0')}` : '';
  out.isManual = out.source === 'manual';
  delete out.inventoryRestoreClaimedAt;
  return out;
}

function serializeProduct(doc) {
  const out = baseSerialize(doc);
  if (out) delete out.stockAdjustmentKeys;
  return out;
}

function serializePayment(doc) {
  const out = baseSerialize(doc);
  if (out) delete out.accessCode;
  return out;
}

/** Turn `[{ _id: sellerId, ... }]` aggregation output into a lookup Map. */
function toMap(rows) {
  return new Map(rows.map((row) => [String(row._id), row]));
}

const adminController = {
  /**
   * @route   GET /api/admin/stats
   * @desc    High-level platform KPIs and operational metrics
   * @access  Private (Admin / Platform Owner)
   */
  async getPlatformStats(req, res, next) {
    try {
      const [sellerRows, productRows, orderRows, totalCustomers, messageRows, paymentRows, feeConfig, recentOrders] =
        await Promise.all([
          User.aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                suspended: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
              },
            },
          ]),
          Product.aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
              },
            },
          ]),
          Order.aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                pending: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Pending'] }, 1, 0] } },
                delivered: { $sum: { $cond: [{ $eq: ['$orderStatus', 'Delivered'] }, 1, 0] } },
                paidCount: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] } },
                totalSales: {
                  $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ifNull: ['$total', 0] }, 0] },
                },
              },
            },
          ]),
          Customer.estimatedDocumentCount(),
          Message.aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
                outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
              },
            },
          ]),
          Payment.aggregate([
            { $match: { status: 'success' } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                platformFee: { $sum: { $ifNull: ['$platformFee', 0] } },
                paystackFee: { $sum: { $ifNull: ['$paystackFee', 0] } },
              },
            },
          ]),
          paymentService.getFeeConfig(),
          Order.find().sort({ createdAt: -1 }).limit(5).lean(),
        ]);

      const sellerAgg = sellerRows[0] || { total: 0, suspended: 0 };
      const productAgg = productRows[0] || { total: 0, active: 0 };
      const orderAgg = orderRows[0] || { total: 0, pending: 0, delivered: 0, paidCount: 0, totalSales: 0 };
      const messageAgg = messageRows[0] || { total: 0, inbound: 0, outbound: 0 };
      const paymentAgg = paymentRows[0] || { count: 0, platformFee: 0, paystackFee: 0 };

      const totalSales = orderAgg.totalSales;
      const paystackFees = paymentAgg.paystackFee;

      // Identical rule to before: trust recorded transactions when any exist,
      // otherwise derive the commission from the current fee policy.
      const platformRevenueFallback = Math.round(
        totalSales * (feeConfig.percentage / 100) + orderAgg.paidCount * feeConfig.fixed
      );
      const platformRevenue = paymentAgg.count > 0 ? paymentAgg.platformFee : platformRevenueFallback;
      const sellerEarnings = Math.max(0, totalSales - platformRevenue - paystackFees);

      res.status(200).json({
        totalSellers: sellerAgg.total,
        activeSellers: sellerAgg.total - sellerAgg.suspended,
        suspendedSellers: sellerAgg.suspended,
        totalProducts: productAgg.total,
        activeProducts: productAgg.active,
        totalOrders: orderAgg.total,
        pendingOrders: orderAgg.pending,
        deliveredOrders: orderAgg.delivered,
        totalCustomers,
        totalMessages: messageAgg.total,
        inboundMessages: messageAgg.inbound,
        outboundMessages: messageAgg.outbound,
        totalSales,
        platformRevenue,
        paystackFees,
        sellerEarnings,
        fee: feeConfig,
        // Only what the overview actually renders. The full orders/products/
        // customers/messages/transactions arrays used to be serialized into
        // this response and thrown away by the client.
        recentOrders: recentOrders.map(serializeOrder),
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/sellers
   * @desc    List all platform sellers with performance metrics
   * @access  Private (Admin / Platform Owner)
   */
  async listSellers(req, res, next) {
    try {
      const [sellers, businesses, productRows, orderRows, customerRows, messageRows] = await Promise.all([
        User.find().select('-password').sort({ createdAt: -1 }).lean(),
        Business.find().lean(),
        Product.aggregate([
          {
            $group: {
              _id: '$sellerId',
              count: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            },
          },
        ]),
        Order.aggregate([
          {
            $group: {
              _id: '$sellerId',
              count: { $sum: 1 },
              revenue: {
                $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, { $ifNull: ['$total', 0] }, 0] },
              },
            },
          },
        ]),
        Customer.aggregate([{ $group: { _id: '$sellerId', count: { $sum: 1 } } }]),
        Message.aggregate([{ $group: { _id: '$sellerId', count: { $sum: 1 } } }]),
      ]);

      const productMap = toMap(productRows);
      const orderMap = toMap(orderRows);
      const customerMap = toMap(customerRows);
      const messageMap = toMap(messageRows);
      const businessMap = new Map(businesses.map((b) => [String(b.sellerId), b]));

      const sellerList = sellers.map((raw) => {
        const seller = serializeUser(raw);
        const key = seller.id;
        const products = productMap.get(key);
        const orders = orderMap.get(key);
        const business = businessMap.get(key);

        return {
          seller,
          business: business ? serializeBusiness(business) : undefined,
          productsCount: products ? products.count : 0,
          activeProducts: products ? products.active : 0,
          ordersCount: orders ? orders.count : 0,
          customersCount: customerMap.has(key) ? customerMap.get(key).count : 0,
          messagesCount: messageMap.has(key) ? messageMap.get(key).count : 0,
          revenue: orders ? orders.revenue : 0,
          telegramConnected: !!(business && business.telegramConnected),
        };
      });

      res.status(200).json(sellerList);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/sellers/:id
   * @desc    Get detailed seller account information
   * @access  Private (Admin / Platform Owner)
   */
  async getSellerDetails(req, res, next) {
    try {
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      const sellerDoc = await User.findById(id).select('-password').lean();
      if (!sellerDoc) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      // Scoped to this seller and bounded: previously every document on the
      // platform was loaded and then filtered down to one tenant in Node.
      const [business, products, orders, customers, messages] = await Promise.all([
        Business.findOne({ sellerId: id }).lean(),
        Product.find({ sellerId: id }).sort({ createdAt: -1 }).limit(DETAIL_LIMIT).lean(),
        Order.find({ sellerId: id }).sort({ createdAt: -1 }).limit(DETAIL_LIMIT).lean(),
        Customer.find({ sellerId: id }).sort({ createdAt: -1 }).limit(DETAIL_LIMIT).lean(),
        Message.find({ sellerId: id }).sort({ timestamp: -1 }).limit(DETAIL_LIMIT).lean(),
      ]);

      res.status(200).json({
        seller: serializeUser(sellerDoc),
        business: business ? serializeBusiness(business) : null,
        products: products.map(serializeProduct),
        orders: orders.map(serializeOrder),
        customers: customers.map(baseSerialize),
        messages: messages.map(baseSerialize),
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   PATCH /api/admin/sellers/:id/status or PATCH /api/admin/sellers/:id/toggle-active
   * @desc    Suspend or activate a seller account
   * @access  Private (Admin / Platform Owner)
   */
  async toggleSellerActive(req, res, next) {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (isActive === undefined) {
        return res.status(400).json({ success: false, message: 'isActive boolean is required' });
      }

      const activeBool = isActive === true || isActive === 'true';

      if (!mongoose.isValidObjectId(id)) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      const user = await User.findByIdAndUpdate(id, { $set: { isActive: activeBool } }, { new: true });
      if (!user) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      logger.info('Seller active status toggled (Admin):', { id, isActive: activeBool });

      // Side effect only: the status change is already durable.
      notificationService
        .sendSellerAccountStatus({ email: user.email, businessName: user.businessName, isActive: activeBool })
        .catch((error) => logger.warn('Could not send seller account-status email:', { id, error: error.message }));

      res.status(200).json(user.toJSON());
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/orders?limit=500
   * @desc    List orders across the entire platform, newest first
   * @access  Private (Admin / Platform Owner)
   */
  async listAllOrders(req, res, next) {
    try {
      const limit = parseLimit(req.query.limit);
      const orders = await Order.find().sort({ createdAt: -1 }).limit(limit).lean();
      res.status(200).json(orders.map(serializeOrder));
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/customers?limit=500
   * @desc    List customers across the entire platform, newest first
   * @access  Private (Admin / Platform Owner)
   */
  async listAllCustomers(req, res, next) {
    try {
      const limit = parseLimit(req.query.limit);
      const customers = await Customer.find().sort({ createdAt: -1 }).limit(limit).lean();
      res.status(200).json(customers.map(baseSerialize));
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/revenue?limit=500
   * @desc    Detailed revenue breakdown by transaction and commission splits
   * @access  Private (Admin / Platform Owner)
   */
  async getRevenueBreakdown(req, res, next) {
    try {
      const limit = parseLimit(req.query.limit);

      // Platform-wide totals come from aggregation so they stay correct even
      // though the per-order breakdown below is capped.
      const [fee, paidOrders, successTxRows, totalsRows] = await Promise.all([
        paymentService.getFeeConfig(),
        Order.find({ paymentStatus: 'Paid' }).sort({ createdAt: -1 }).limit(limit).lean(),
        Payment.find({ status: 'success' }).sort({ createdAt: -1 }).limit(limit).lean(),
        Order.aggregate([
          { $match: { paymentStatus: 'Paid' } },
          { $group: { _id: null, totalSales: { $sum: { $ifNull: ['$total', 0] } }, paidCount: { $sum: 1 } } },
        ]),
      ]);

      const txByOrder = new Map();
      successTxRows.forEach((tx) => {
        const key = String(tx.orderId);
        if (!txByOrder.has(key)) txByOrder.set(key, tx);
      });

      const breakdown = paidOrders.map((raw) => {
        const o = serializeOrder(raw);
        const tx = txByOrder.get(o.id);
        const feeAmount = tx ? tx.platformFee : Math.round(o.total * (fee.percentage / 100) + fee.fixed);
        const paystackFee = tx ? tx.paystackFee : Math.min(Math.round(o.total * 0.015), 2000);
        const sellerEarning = Math.max(0, o.total - feeAmount - paystackFee);

        return {
          orderId: o.id,
          sellerId: o.sellerId,
          customerName: o.customerName,
          total: o.total,
          fee: feeAmount,
          paystackFee,
          sellerEarning,
          reference: (tx && tx.reference) || o.paymentReference || '—',
          createdAt: o.createdAt,
        };
      });

      const totals = totalsRows[0] || { totalSales: 0, paidCount: 0 };
      const totalSales = totals.totalSales;
      const platformRevenue = breakdown.reduce((sum, b) => sum + b.fee, 0);
      const paystackFees = breakdown.reduce((sum, b) => sum + b.paystackFee, 0);

      res.status(200).json({
        breakdown,
        totalSales,
        platformRevenue,
        paystackFees,
        sellerEarnings: Math.max(0, totalSales - platformRevenue - paystackFees),
        fee,
        // Count only - the full transaction array was never read by the client.
        transactionsCount: successTxRows.length,
        truncated: totals.paidCount > breakdown.length,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/telegram
   * @desc    Platform-wide Telegram messaging and AI interaction metrics
   * @access  Private (Admin / Platform Owner)
   */
  async getTelegramStats(req, res, next) {
    try {
      const [sellers, businesses, messageRows] = await Promise.all([
        User.find().select('businessName email').sort({ createdAt: -1 }).lean(),
        Business.find().select('sellerId telegramBotUsername telegramConnected').lean(),
        Message.aggregate([
          { $match: { channel: 'telegram' } },
          {
            $group: {
              _id: '$sellerId',
              totalMessages: { $sum: 1 },
              inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
              outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
              aiMessages: {
                $sum: {
                  $cond: [
                    { $and: [{ $ne: ['$deterministic', true] }, { $eq: ['$direction', 'outbound'] }] },
                    1,
                    0,
                  ],
                },
              },
              lastMessageAt: { $max: '$timestamp' },
            },
          },
        ]),
      ]);

      const messageMap = toMap(messageRows);
      const businessMap = new Map(businesses.map((b) => [String(b.sellerId), b]));

      const stats = sellers.map((raw) => {
        const id = raw._id.toString();
        const business = businessMap.get(id);
        const m = messageMap.get(id);

        return {
          sellerId: id,
          businessName: raw.businessName,
          email: raw.email,
          botUsername: (business && business.telegramBotUsername) || '',
          telegramConnected: !!(business && business.telegramConnected),
          totalMessages: m ? m.totalMessages : 0,
          inbound: m ? m.inbound : 0,
          outbound: m ? m.outbound : 0,
          aiMessages: m ? m.aiMessages : 0,
          // `$max` is the genuine most recent message. The previous code read
          // the last element of a descending array, i.e. the OLDEST message.
          lastMessageAt: m ? m.lastMessageAt : null,
        };
      });

      res.status(200).json(stats);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/fee & PATCH /api/admin/fee
   * @desc    Get or update global platform commission fee policy
   * @access  Private (Admin / Platform Owner)
   */
  async getFeeConfig(req, res, next) {
    try {
      const cfg = await paymentService.getFeeConfig();
      res.status(200).json(cfg);
    } catch (error) {
      next(error);
    }
  },

  async updateFeeConfig(req, res, next) {
    try {
      const cfg = await paymentService.setFeeConfig(req.body);
      res.status(200).json(cfg);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/payouts
   * @desc    List all platform seller payout requests
   * @access  Private (Admin)
   */
  async listPayouts(req, res, next) {
    try {
      const payouts = await payoutService.listAll();
      res.status(200).json(payouts);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   PATCH /api/admin/payouts/:id/process
   * @desc    Approve or reject a seller payout request
   * @access  Private (Admin)
   */
  async processPayout(req, res, next) {
    try {
      const { id } = req.params;
      const { status, rejectionReason } = req.body;
      const updated = await payoutService.processPayout(id, { status, rejectionReason });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = adminController;
