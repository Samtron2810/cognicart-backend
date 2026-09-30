/**
 * Order Processing and Management Service
 * Multi-tenant order lifecycle, frozen price snapshots, stock reservation, and idempotency
 */

const mongoose = require('mongoose');
const Order = require('../../models/Order');
const { AUTOMATIC_SOURCES } = require('../../models/Order');
const { nextOrderNumber } = require('../../models/Counter');
const { getEffectivePrice } = require('../../models/Product');
const customerService = require('../customers/customerService');
const productService = require('../products/productService');
const businessService = require('../sellers/businessService');
const { sanitize, escapeRegex, normalizePhone, isEmail } = require('../../utils/validators');
const { counterpartyOrderFilter } = require('../ai/toolGuards');
const logger = require('../../utils/logger');

function getNotificationService() {
  try {
    return require('../notifications/notificationService');
  } catch {
    return null;
  }
}

function notFound(message = 'Order not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function identifierFilter(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw httpError('Order reference is required');
  if (mongoose.isValidObjectId(raw)) return { _id: raw };

  const normalized = raw.replace(/^order\s*/i, '').replace(/^ord[-_\s#]*/i, '').replace(/^#/, '');
  if (/^\d+$/.test(normalized)) {
    const orderNumber = Number(normalized);
    if (Number.isSafeInteger(orderNumber) && orderNumber > 0) return { orderNumber };
  }
  throw notFound();
}

async function restoreCancelledInventory(order) {
  const shouldRestore = order.source !== 'manual' || order.inventoryAdjusted === true;
  if (!shouldRestore || order.inventoryRestoredAt) return order.toJSON();

  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      inventoryRestoredAt: null,
    },
    { $set: { inventoryRestoreClaimedAt: new Date() } },
    { new: true }
  ).select('+inventoryRestoreClaimedAt');

  if (!claimed) {
    const current = await Order.findById(order._id);
    return current ? current.toJSON() : order.toJSON();
  }

  // Concurrent workers may both reach this loop, but each Product increment is
  // guarded by its own atomic operation key. That avoids both duplicate stock
  // and a stale global lock after a process crash.

  try {
    for (const [index, item] of (claimed.items || []).entries()) {
      if (!item.productId) continue;
      const operationKey = `${claimed._id}:cancel:${index}:${item.productId}:${item.variantId || 'base'}`;
      await productService.restoreStockOnce(
        item.productId,
        claimed.sellerId,
        Number(item.quantity),
        item.variantId,
        operationKey
      );
    }
    const completed = await Order.findByIdAndUpdate(
      claimed._id,
      {
        $set: { inventoryRestoredAt: new Date() },
        $unset: { inventoryRestoreClaimedAt: 1 },
      },
      { new: true }
    );
    return completed.toJSON();
  } catch (error) {
    // Successful Product updates carry durable idempotency keys. Releasing the
    // claim lets a retry continue the unfinished items without incrementing any
    // item that was already restored.
    await Order.updateOne(
      { _id: claimed._id, inventoryRestoredAt: null },
      { $unset: { inventoryRestoreClaimedAt: 1 } }
    );
    throw httpError(`Order was cancelled but inventory restoration failed: ${error.message}`, 500);
  }
}

const orderService = {
  /**
   * Create an order with authoritative price calculation and stock deduction
   */
  async create(sellerId, payload, idempotencyKey, options = {}) {
    if (!sellerId) {
      const err = new Error('Seller ID is required');
      err.statusCode = 400;
      throw err;
    }

    // Idempotency guard: return cached order if key was already processed
    if (idempotencyKey) {
      const existingOrder = await Order.findOne({ sellerId, idempotencyKey });
      if (existingOrder) {
        logger.info('Idempotent order hit:', { idempotencyKey, orderId: existingOrder._id.toString() });
        return existingOrder.toJSON();
      }
    }

    if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
      const err = new Error('Order must contain at least one item');
      err.statusCode = 400;
      throw err;
    }

    if (!payload.customer || !payload.customer.name || !payload.customer.phone) {
      const err = new Error('Customer name and phone number are required');
      err.statusCode = 400;
      throw err;
    }

    const customerName = sanitize(payload.customer.name, 100);
    const customerPhone = normalizePhone(payload.customer.phone) || payload.customer.phone.trim();
    const rawEmail = String(payload.customer.email || '').trim().toLowerCase();
    const customerEmail = isEmail(rawEmail) ? rawEmail : '';
    const customerAddress = sanitize(payload.deliveryAddress || payload.customer.address || '', 300);
    const source = AUTOMATIC_SOURCES.includes(options.source) ? options.source : 'storefront';

    // Telegram identity is decisive. Contact sharing may prove a phone but it
    // must not merge or claim a same-phone storefront/email profile.
    let customer;
    if (source === 'telegram' && options.channelUserId) {
      customer = await customerService.findByIdentity(
        sellerId,
        'telegram',
        String(options.channelUserId)
      );
      if (!customer || !customer.phone || customer.phone !== customerPhone) {
        const err = new Error('Share your own phone number in Telegram before placing an order');
        err.statusCode = 400;
        throw err;
      }
      customer = await customerService.refreshByIdentity(
        sellerId,
        'telegram',
        String(options.channelUserId),
        {
          name: customerName,
          phone: customerPhone,
          address: customerAddress,
        }
      );
    } else {
      // Storefront identity continues to use exact phone+email profiles.
      customer = await customerService.upsert(sellerId, {
        name: customerName,
        phone: customerPhone,
        address: customerAddress,
        email: customerEmail,
        shopperId: payload.shopperId || null,
      });
    }

    // Validate and freeze authoritative prices for each order item
    const validatedItems = [];
    let subtotal = 0;

    for (const item of payload.items) {
      if (!item.productId) {
        const err = new Error('Each order item must specify a productId');
        err.statusCode = 400;
        throw err;
      }

      const qty = parseInt(item.quantity, 10);
      if (isNaN(qty) || qty <= 0) {
        const err = new Error('Item quantity must be a positive integer');
        err.statusCode = 400;
        throw err;
      }

      // Fetch authoritative product from the database
      const product = await productService.getById(item.productId, sellerId);
      if (!product) {
        const err = new Error(`Product not found or does not belong to this seller: ${item.productId}`);
        err.statusCode = 404;
        throw err;
      }

      let variant = null;
      let variantLabel = '';

      if (item.variantId) {
        variant = (product.variants || []).find((v) => v.id === item.variantId);
        if (!variant) {
          const err = new Error(`Variant not found for product: ${product.name}`);
          err.statusCode = 404;
          throw err;
        }
        variantLabel = [variant.size, variant.color, variant.sku].filter(Boolean).join(' / ');
      }

      // Calculate authoritative effective price (never trust frontend or AI pricing!)
      const unitPrice = getEffectivePrice(product, variant);
      const itemSubtotal = unitPrice * qty;
      subtotal += itemSubtotal;

      // Deduct stock from product
      await productService.adjustStock(product.id, sellerId, qty, item.variantId);

      validatedItems.push({
        productId: product.id.toString(),
        variantId: item.variantId || undefined,
        variantLabel: variantLabel || undefined,
        name: product.name,
        price: unitPrice,
        quantity: qty,
        image: (variant && variant.image) || (product.images && product.images[0]) || '',
        subtotal: itemSubtotal,
      });
    }

    // Determine delivery fee using seller's business settings
    let deliveryFee = 0;
    if (payload.deliveryFee !== undefined && !isNaN(Number(payload.deliveryFee))) {
      deliveryFee = Math.max(0, Number(payload.deliveryFee));
    } else {
      const biz = await businessService.getBySellerId(sellerId);
      if (biz && biz.freeDeliveryThreshold && subtotal >= biz.freeDeliveryThreshold) {
        deliveryFee = 0;
      } else {
        deliveryFee = biz && biz.deliveryFee !== undefined ? biz.deliveryFee : 1500;
      }
    }

    const total = subtotal + deliveryFee;

    // Automatic checkout always starts unpaid. Neither a public storefront
    // request nor an AI tool may assert that money was received; only the
    // Paystack verification path may promote it to Paid. Manually logged orders
    // use the separate, seller-authenticated manualOrderService.
    const orderNumber = await nextOrderNumber(sellerId);

    const order = await Order.create({
      sellerId,
      customerId: customer.id,
      customerName,
      customerPhone,
      customerEmail,
      source,
      sourceChannel: '',
      channel: options.channel || (source === 'telegram' ? 'telegram' : 'storefront'),
      channelAccountId: options.channelAccountId || '',
      channelUserId: options.channelUserId || '',
      channelUsername: options.channelUsername || '',
      sourceNote: '',
      enteredBy: '',
      orderNumber,
      deliveryAddress: customerAddress,
      items: validatedItems,
      subtotal,
      deliveryFee,
      total,
      paymentStatus: 'Pending',
      paymentMethod: 'paystack',
      orderStatus: 'Pending',
      paymentReference: '',
      paidAt: null,
      idempotencyKey: idempotencyKey || undefined,
      shopperId: payload.shopperId || null,
    });

    await customerService.incrementOnOrder(customer.id, sellerId, total);
    logger.info('Order created successfully:', { id: order._id.toString(), sellerId, total });

    const orderJson = order.toJSON();
    const ns = getNotificationService();
    if (ns) ns.sendOrderConfirmation(orderJson).catch(() => {});
    return orderJson;
  },

  /**
   * List orders for a seller with status filtering and search
   */
  async list(sellerId, { status, paymentStatus, source, sourceChannel, search, from, to } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const filter = { sellerId };
    if (status) filter.orderStatus = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (source === 'automatic') filter.source = { $in: AUTOMATIC_SOURCES };
    else if (source) filter.source = source;
    if (sourceChannel) filter.sourceChannel = sourceChannel;

    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const start = new Date(from);
        if (!Number.isNaN(start.getTime())) filter.createdAt.$gte = start;
      }
      if (to) {
        const end = new Date(to);
        if (!Number.isNaN(end.getTime())) filter.createdAt.$lte = end;
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }

    if (search) {
      const rawSearch = sanitize(search, 100);
      const q = escapeRegex(rawSearch);
      const numericReference = Number(rawSearch.replace(/^#/, ''));
      filter.$or = [
        { customerName: { $regex: q, $options: 'i' } },
        { customerPhone: { $regex: q, $options: 'i' } },
        { 'items.name': { $regex: q, $options: 'i' } },
        { sourceNote: { $regex: q, $options: 'i' } },
      ];
      if (Number.isInteger(numericReference) && numericReference > 0) {
        filter.$or.push({ orderNumber: numericReference });
      }
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 });
    return orders.map((o) => o.toJSON());
  },

  /**
   * Dashboard totals and source splits for the seller order-management page.
   * Revenue means verified/recorded Paid orders, never merely created orders.
   */
  async getSummary(sellerId, { from, to } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const match = { sellerId };
    if (from || to) {
      match.createdAt = {};
      if (from) {
        const start = new Date(from);
        if (!Number.isNaN(start.getTime())) match.createdAt.$gte = start;
      }
      if (to) {
        const end = new Date(to);
        if (!Number.isNaN(end.getTime())) match.createdAt.$lte = end;
      }
      if (Object.keys(match.createdAt).length === 0) delete match.createdAt;
    }

    const [result] = await Order.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                orders: { $sum: 1 },
                grossOrderValue: { $sum: '$total' },
                paidRevenue: {
                  $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$total', 0] },
                },
                outstanding: {
                  $sum: { $cond: [{ $eq: ['$paymentStatus', 'Pending'] }, '$total', 0] },
                },
              },
            },
          ],
          bySource: [
            { $group: { _id: '$source', orders: { $sum: 1 }, value: { $sum: '$total' } } },
            { $sort: { orders: -1 } },
          ],
          byStatus: [
            { $group: { _id: '$orderStatus', orders: { $sum: 1 } } },
            { $sort: { orders: -1 } },
          ],
          byPaymentStatus: [
            { $group: { _id: '$paymentStatus', orders: { $sum: 1 }, value: { $sum: '$total' } } },
            { $sort: { orders: -1 } },
          ],
        },
      },
    ]);

    const totals = (result && result.totals && result.totals[0]) || {
      orders: 0,
      grossOrderValue: 0,
      paidRevenue: 0,
      outstanding: 0,
    };
    delete totals._id;

    return {
      totals,
      bySource: (result && result.bySource) || [],
      byStatus: (result && result.byStatus) || [],
      byPaymentStatus: (result && result.byPaymentStatus) || [],
    };
  },

  /** Buyer-visible recent orders, always scoped to the conversation identity. */
  async listForCounterparty(sellerId, context, { status, paymentStatus, limit = 5 } = {}) {
    const filter = counterpartyOrderFilter(sellerId, context);
    if (status) filter.orderStatus = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    const capped = Math.min(Math.max(Number(limit) || 5, 1), 10);
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(capped);
    return orders.map((order) => order.toJSON());
  },

  /** Resolve an ObjectId or human reference without leaving buyer scope. */
  async resolveForCounterparty(sellerId, identifier, context) {
    const filter = {
      ...counterpartyOrderFilter(sellerId, context),
      ...identifierFilter(identifier),
    };
    const order = await Order.findOne(filter);
    if (!order) throw notFound();
    return order.toJSON();
  },

  /**
   * Cancel an unpaid, unfulfilled order and restore reserved inventory exactly
   * once. Paid/processing/shipped orders require a seller-managed refund flow.
   */
  async cancel(id, sellerId, { cancelledBy = 'seller', reason = '' } = {}) {
    if (!id || !mongoose.isValidObjectId(id)) throw notFound();
    let order = await Order.findOne({ _id: id, sellerId }).select('+inventoryRestoreClaimedAt');
    if (!order) throw notFound();

    if (order.paymentStatus === 'Paid') {
      throw httpError('A paid order cannot be cancelled until its payment is refunded', 409);
    }
    if (!['Pending', 'Confirmed', 'Cancelled'].includes(order.orderStatus)) {
      throw httpError(`This order can no longer be cancelled because it is ${order.orderStatus}`, 409);
    }

    const alreadyCancelled = order.orderStatus === 'Cancelled';
    if (!alreadyCancelled) {
      order = await Order.findOneAndUpdate(
        {
          _id: id,
          sellerId,
          paymentStatus: { $ne: 'Paid' },
          orderStatus: { $in: ['Pending', 'Confirmed'] },
        },
        {
          $set: {
            orderStatus: 'Cancelled',
            cancelledAt: new Date(),
            cancelledBy,
            cancellationReason: sanitize(reason || 'Cancelled before fulfillment', 300),
          },
        },
        { new: true }
      ).select('+inventoryRestoreClaimedAt');
      if (!order) throw httpError('Order changed and can no longer be cancelled', 409);
    }

    // Pending links are invalid inside this application from this point. If an
    // already-open provider page completes later, verification queues a refund.
    let paymentAbandonError = null;
    try {
      const paymentService = require('../payments/paymentService');
      await paymentService.abandonPendingForOrder(order._id.toString(), sellerId, 'order_cancelled');
    } catch (error) {
      paymentAbandonError = error;
      logger.error('Could not abandon pending payment during cancellation:', {
        orderId: order._id.toString(),
        error: error.message,
      });
    }

    const restored = await restoreCancelledInventory(order);
    if (paymentAbandonError) {
      throw httpError(
        `Order was cancelled but pending payment invalidation failed: ${paymentAbandonError.message}`,
        500
      );
    }
    if (!alreadyCancelled && restored.source !== 'manual') {
      const ns = getNotificationService();
      if (ns) ns.sendOrderStatusUpdate(restored, 'Cancelled').catch(() => {});
    }
    logger.info('Order cancelled:', { id, sellerId, cancelledBy });
    return restored;
  },

  async cancelForCounterparty(sellerId, identifier, context, reason = '') {
    const order = await this.resolveForCounterparty(sellerId, identifier, context);
    if (order.source === 'manual') throw notFound();
    return this.cancel(order.id, sellerId, { cancelledBy: 'buyer', reason });
  },

  /**
   * Get single order by ID (tenant isolation enforced)
   */
  async getById(id, sellerId) {
    if (!id || !mongoose.isValidObjectId(id)) throw notFound();

    const query = { _id: id };
    if (sellerId) query.sellerId = sellerId;

    const order = await Order.findOne(query);
    if (!order) throw notFound();

    return order.toJSON();
  },

  /**
   * Update order fulfillment status
   */
  async updateStatus(id, sellerId, orderStatus) {
    const validStatuses = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(orderStatus)) {
      const err = new Error(`Invalid order status. Allowed: ${validStatuses.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }

    if (!id || !mongoose.isValidObjectId(id)) throw notFound();
    if (orderStatus === 'Cancelled') {
      return this.cancel(id, sellerId, { cancelledBy: 'seller', reason: 'Cancelled by seller' });
    }

    const order = await Order.findOneAndUpdate(
      { _id: id, sellerId, orderStatus: { $ne: 'Cancelled' } },
      { $set: { orderStatus } },
      { new: true }
    );
    if (!order) throw notFound();

    logger.info('Order status updated:', { id, orderStatus });
    const orderJson = order.toJSON();
    // Manually logged orders are records of conversations happening elsewhere;
    // never surprise the merchant by auto-sending through an API channel. They
    // can explicitly request a copy/share link from GET /:id/share.
    if (orderJson.source !== 'manual') {
      const ns = getNotificationService();
      if (ns) ns.sendOrderStatusUpdate(orderJson, orderStatus).catch(() => {});
    }
    return orderJson;
  },

  /**
   * Update order payment status and reference
   */
  async updatePaymentStatus(id, sellerId, paymentStatus, paymentReference) {
    const validStatuses = ['Pending', 'Paid', 'Failed', 'Refunded'];
    if (!validStatuses.includes(paymentStatus)) {
      const err = new Error(`Invalid payment status. Allowed: ${validStatuses.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }

    if (!id || !mongoose.isValidObjectId(id)) throw notFound();

    const updates = { paymentStatus };
    if (paymentStatus === 'Paid') updates.paidAt = new Date();
    else if (paymentStatus === 'Pending' || paymentStatus === 'Failed') updates.paidAt = null;
    if (paymentReference) updates.paymentReference = paymentReference;

    const query = { _id: id };
    if (sellerId) query.sellerId = sellerId;

    const order = await Order.findOneAndUpdate(query, { $set: updates }, { new: true });
    if (!order) throw notFound();

    return order.toJSON();
  },
};

module.exports = orderService;
