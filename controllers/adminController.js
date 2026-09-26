/**
 * Platform Administration & Revenue Controller
 * Manages SaaS owner analytics, revenue distribution, seller account states, and fee policies
 */

const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Payment = require('../models/Payment');
const Business = require('../models/Business');
const { isDbConnected } = require('../config/db');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');
const orderService = require('../services/orders/orderService');
const customerService = require('../services/customers/customerService');
const messageService = require('../services/whatsapp/messageService');
const paymentService = require('../services/payments/paymentService');
const payoutService = require('../services/payouts/payoutService');
const logger = require('../utils/logger');

/**
 * Fetch all platform entities across DB or memory
 */
async function getAllPlatformEntities() {
  if (isDbConnected()) {
    const [sellers, products, orders, customers, messages, transactions, businesses] = await Promise.all([
      User.find().sort({ createdAt: -1 }),
      Product.find().sort({ createdAt: -1 }),
      Order.find().sort({ createdAt: -1 }),
      Customer.find().sort({ createdAt: -1 }),
      Message.find().sort({ timestamp: -1 }),
      Payment.find().sort({ createdAt: -1 }),
      Business.find(),
    ]);

    return {
      sellers: sellers.map((s) => s.toJSON()),
      products: products.map((p) => p.toJSON()),
      orders: orders.map((o) => o.toJSON()),
      customers: customers.map((c) => c.toJSON()),
      messages: messages.map((m) => m.toJSON()),
      transactions: transactions.map((t) => t.toJSON()),
      businesses: businesses.map((b) => b.toJSON()),
    };
  }

  // Memory fallback
  const { users, businesses: memBiz } = authService.getMemoryStore();
  const memProducts = productService.getMemoryStore();
  const memOrders = orderService.getMemoryStore();
  const memCustomers = customerService.getMemoryStore();
  const { messages: memMsgs } = messageService.getMemoryStore();
  const memPayments = paymentService.getMemoryStore();

  return {
    sellers: Array.from(users.values()).map(({ password: _p, ...u }) => u),
    products: Array.from(memProducts.values()),
    orders: Array.from(memOrders.values()),
    customers: Array.from(memCustomers.values()),
    messages: memMsgs,
    transactions: Array.from(memPayments.values()),
    businesses: Array.from(memBiz.values()),
  };
}

const adminController = {
  /**
   * @route   GET /api/admin/stats
   * @desc    High-level platform KPIs and operational metrics
   * @access  Private (Admin / Platform Owner)
   */
  async getPlatformStats(req, res, next) {
    try {
      const { sellers, products, orders, customers, messages, transactions } = await getAllPlatformEntities();
      const feeConfig = await paymentService.getFeeConfig();

      const paidOrders = orders.filter((o) => o.paymentStatus === 'Paid');
      const totalSales = paidOrders.reduce((sum, o) => sum + (o.total || 0), 0);

      const successfulTxs = transactions.filter((t) => t.status === 'success');
      const platformRevenueByTx = successfulTxs.reduce((sum, t) => sum + (t.platformFee || 0), 0);
      const paystackFees = successfulTxs.reduce((sum, t) => sum + (t.paystackFee || 0), 0);

      const platformRevenueFallback = Math.round(
        totalSales * (feeConfig.percentage / 100) + paidOrders.length * feeConfig.fixed
      );

      const platformRevenue = successfulTxs.length > 0 ? platformRevenueByTx : platformRevenueFallback;
      const sellerEarnings = Math.max(0, totalSales - platformRevenue - paystackFees);

      res.status(200).json({
        totalSellers: sellers.length,
        activeSellers: sellers.filter((s) => s.isActive !== false).length,
        suspendedSellers: sellers.filter((s) => s.isActive === false).length,
        totalProducts: products.length,
        activeProducts: products.filter((p) => p.isActive).length,
        totalOrders: orders.length,
        pendingOrders: orders.filter((o) => o.orderStatus === 'Pending').length,
        deliveredOrders: orders.filter((o) => o.orderStatus === 'Delivered').length,
        totalCustomers: customers.length,
        totalMessages: messages.length,
        inboundMessages: messages.filter((m) => m.direction === 'inbound').length,
        outboundMessages: messages.filter((m) => m.direction === 'outbound').length,
        totalSales,
        platformRevenue,
        paystackFees,
        sellerEarnings,
        fee: feeConfig,
        orders,
        products,
        customers,
        messages,
        transactions,
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
      const { sellers, products, orders, customers, messages, businesses } = await getAllPlatformEntities();

      const sellerList = sellers.map((s) => {
        const sProducts = products.filter((p) => p.sellerId === s.id);
        const sOrders = orders.filter((o) => o.sellerId === s.id);
        const sCustomers = customers.filter((c) => c.sellerId === s.id);
        const sMessages = messages.filter((m) => m.sellerId === s.id);
        const business = businesses.find((b) => b.sellerId === s.id);

        const revenue = sOrders.filter((o) => o.paymentStatus === 'Paid').reduce((sum, o) => sum + o.total, 0);

        return {
          seller: s,
          business,
          productsCount: sProducts.length,
          activeProducts: sProducts.filter((p) => p.isActive).length,
          ordersCount: sOrders.length,
          customersCount: sCustomers.length,
          messagesCount: sMessages.length,
          revenue,
          whatsappConnected: !!(business && business.whatsappConnected),
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
      const { sellers, products, orders, customers, messages, businesses } = await getAllPlatformEntities();

      const seller = sellers.find((s) => s.id === id);
      if (!seller) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      const business = businesses.find((b) => b.sellerId === id) || null;
      const sProducts = products.filter((p) => p.sellerId === id);
      const sOrders = orders.filter((o) => o.sellerId === id);
      const sCustomers = customers.filter((c) => c.sellerId === id);
      const sMessages = messages.filter((m) => m.sellerId === id);

      res.status(200).json({
        seller,
        business,
        products: sProducts,
        orders: sOrders,
        customers: sCustomers,
        messages: sMessages,
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

      if (isDbConnected()) {
        const user = await User.findByIdAndUpdate(id, { $set: { isActive: activeBool } }, { new: true });
        if (!user) {
          return res.status(404).json({ success: false, message: 'Seller not found' });
        }
        return res.status(200).json(user.toJSON());
      }

      const { users } = authService.getMemoryStore();
      const user = users.get(id);
      if (!user) {
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }

      user.isActive = activeBool;
      user.updatedAt = new Date().toISOString();
      users.set(id, user);

      const { password: _p, ...sanitized } = user;
      logger.info('Seller active status toggled (Admin):', { id, isActive: activeBool });
      res.status(200).json(sanitized);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/orders
   * @desc    List all orders across the entire platform
   * @access  Private (Admin / Platform Owner)
   */
  async listAllOrders(req, res, next) {
    try {
      const { orders } = await getAllPlatformEntities();
      res.status(200).json(orders);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/customers
   * @desc    List all customers across the entire platform
   * @access  Private (Admin / Platform Owner)
   */
  async listAllCustomers(req, res, next) {
    try {
      const { customers } = await getAllPlatformEntities();
      res.status(200).json(customers);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/revenue
   * @desc    Detailed revenue breakdown by transaction and commission splits
   * @access  Private (Admin / Platform Owner)
   */
  async getRevenueBreakdown(req, res, next) {
    try {
      const { orders, transactions } = await getAllPlatformEntities();
      const fee = await paymentService.getFeeConfig();

      const paidOrders = orders.filter((o) => o.paymentStatus === 'Paid');
      const breakdown = paidOrders.map((o) => {
        const tx = transactions.find((t) => t.orderId === o.id && t.status === 'success');
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

      const totalSales = paidOrders.reduce((sum, o) => sum + o.total, 0);
      const platformRevenue = breakdown.reduce((sum, b) => sum + b.fee, 0);
      const paystackFees = breakdown.reduce((sum, b) => sum + b.paystackFee, 0);

      res.status(200).json({
        breakdown,
        totalSales,
        platformRevenue,
        paystackFees,
        sellerEarnings: Math.max(0, totalSales - platformRevenue - paystackFees),
        fee,
        transactions,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/whatsapp
   * @desc    Platform-wide WhatsApp messaging and AI interaction metrics
   * @access  Private (Admin / Platform Owner)
   */
  async getWhatsAppStats(req, res, next) {
    try {
      const { sellers, messages, businesses } = await getAllPlatformEntities();

      const stats = sellers.map((s) => {
        const sMessages = messages.filter((m) => m.sellerId === s.id);
        const business = businesses.find((b) => b.sellerId === s.id);

        return {
          sellerId: s.id,
          businessName: s.businessName,
          email: s.email,
          businessPhone: (business && business.whatsappPhone) || '—',
          whatsappConnected: !!(business && business.whatsappConnected),
          totalMessages: sMessages.length,
          inbound: sMessages.filter((m) => m.direction === 'inbound').length,
          outbound: sMessages.filter((m) => m.direction === 'outbound').length,
          aiMessages: sMessages.filter((m) => !m.deterministic && m.direction === 'outbound').length,
          lastMessageAt: sMessages.length ? sMessages[sMessages.length - 1].timestamp : null,
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
