/**
 * Order Processing and Management Service
 * Multi-tenant order lifecycle, frozen price snapshots, stock reservation, and idempotency
 */

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const { getEffectivePrice } = require('../../models/Product');
const { isDbConnected } = require('../../config/db');
const customerService = require('../customers/customerService');
const productService = require('../products/productService');
const businessService = require('../sellers/businessService');
const { sanitize, normalizePhone } = require('../../utils/validators');
const logger = require('../../utils/logger');

function getNotificationService() {
  try {
    return require('../notifications/notificationService');
  } catch {
    return null;
  }
}

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryOrders = new Map();
const memoryIdempotency = new Map();

const orderService = {
  /**
   * Create an order with authoritative price calculation and stock deduction
   */
  async create(sellerId, payload, idempotencyKey) {
    if (!sellerId) {
      const err = new Error('Seller ID is required');
      err.statusCode = 400;
      throw err;
    }

    // Idempotency guard: return cached order if key was already processed
    if (idempotencyKey) {
      if (isDbConnected()) {
        const existingOrder = await Order.findOne({ sellerId, idempotencyKey });
        if (existingOrder) {
          logger.info('Idempotent order hit (DB):', { idempotencyKey, orderId: existingOrder._id.toString() });
          return existingOrder.toJSON();
        }
      } else {
        const cachedId = memoryIdempotency.get(idempotencyKey);
        if (cachedId && memoryOrders.has(cachedId)) {
          logger.info('Idempotent order hit (Memory):', { idempotencyKey, orderId: cachedId });
          return memoryOrders.get(cachedId);
        }
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
    const customerAddress = sanitize(payload.deliveryAddress || payload.customer.address || '', 300);

    // Upsert customer profile under seller
    const customer = await customerService.upsert(sellerId, {
      name: customerName,
      phone: customerPhone,
      whatsappId: payload.customer.whatsappId || customerPhone,
      address: customerAddress,
      email: payload.customer.email,
    });

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

      // Fetch authoritative product from DB or memory
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
      await productService.adjustStock(product.id || product._id, sellerId, qty, item.variantId);

      validatedItems.push({
        productId: (product.id || product._id).toString(),
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

    const orderData = {
      sellerId,
      customerId: customer.id,
      customerName,
      customerPhone,
      customerWhatsappId: customer.whatsappId || customerPhone,
      deliveryAddress: customerAddress,
      items: validatedItems,
      subtotal,
      deliveryFee,
      total,
      paymentStatus: payload.paymentStatus || 'Pending',
      orderStatus: 'Pending',
      paymentReference: payload.paymentReference || '',
      idempotencyKey: idempotencyKey || undefined,
    };

    if (isDbConnected()) {
      const order = await Order.create(orderData);
      await customerService.incrementOnOrder(customer.id, sellerId, total);
      logger.info('Order created successfully (DB):', { id: order._id.toString(), sellerId, total });
      const orderJson = order.toJSON();
      const ns = getNotificationService();
      if (ns) ns.sendOrderConfirmation(orderJson).catch(() => {});
      return orderJson;
    }

    // In-memory fallback
    const id = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const memOrder = {
      id,
      _id: id,
      ...orderData,
      createdAt: now,
      updatedAt: now,
    };
    memoryOrders.set(id, memOrder);

    if (idempotencyKey) {
      memoryIdempotency.set(idempotencyKey, id);
    }

    await customerService.incrementOnOrder(customer.id, sellerId, total);
    logger.info('Order created successfully (Memory):', { id, sellerId, total });
    const ns = getNotificationService();
    if (ns) ns.sendOrderConfirmation(memOrder).catch(() => {});
    return memOrder;
  },

  /**
   * List orders for a seller with status filtering and search
   */
  async list(sellerId, { status, paymentStatus, search } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (isDbConnected()) {
      const filter = { sellerId };
      if (status) filter.orderStatus = status;
      if (paymentStatus) filter.paymentStatus = paymentStatus;
      if (search) {
        const q = sanitize(search, 100);
        filter.$or = [
          { customerName: { $regex: q, $options: 'i' } },
          { customerPhone: { $regex: q, $options: 'i' } },
          { 'items.name': { $regex: q, $options: 'i' } },
        ];
      }
      const orders = await Order.find(filter).sort({ createdAt: -1 });
      return orders.map((o) => o.toJSON());
    }

    // In-memory fallback
    let list = Array.from(memoryOrders.values()).filter((o) => o.sellerId === sellerId);
    if (status) list = list.filter((o) => o.orderStatus === status);
    if (paymentStatus) list = list.filter((o) => o.paymentStatus === paymentStatus);
    if (search) {
      const q = sanitize(search, 100).toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.customerPhone.includes(q) ||
          (o.items || []).some((item) => item.name.toLowerCase().includes(q))
      );
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  /**
   * Get single order by ID (tenant isolation enforced)
   */
  async getById(id, sellerId) {
    if (isDbConnected()) {
      const query = { _id: id };
      if (sellerId) query.sellerId = sellerId;
      const order = await Order.findOne(query);
      if (!order) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      return order.toJSON();
    }

    const order = memoryOrders.get(id);
    if (!order || (sellerId && order.sellerId !== sellerId)) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    return order;
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

    if (isDbConnected()) {
      const order = await Order.findOneAndUpdate(
        { _id: id, sellerId },
        { $set: { orderStatus } },
        { new: true }
      );
      if (!order) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      logger.info('Order status updated (DB):', { id, orderStatus });
      const orderJson = order.toJSON();
      const ns = getNotificationService();
      if (ns) ns.sendOrderStatusUpdate(orderJson, orderStatus).catch(() => {});
      return orderJson;
    }

    const order = memoryOrders.get(id);
    if (!order || order.sellerId !== sellerId) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    order.orderStatus = orderStatus;
    order.updatedAt = new Date().toISOString();
    memoryOrders.set(id, order);
    logger.info('Order status updated (Memory):', { id, orderStatus });
    const ns = getNotificationService();
    if (ns) ns.sendOrderStatusUpdate(order, orderStatus).catch(() => {});
    return order;
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

    const updates = { paymentStatus };
    if (paymentReference) updates.paymentReference = paymentReference;

    if (isDbConnected()) {
      const query = { _id: id };
      if (sellerId) query.sellerId = sellerId;
      const order = await Order.findOneAndUpdate(query, { $set: updates }, { new: true });
      if (!order) throw new Error('Order not found');
      return order.toJSON();
    }

    const order = memoryOrders.get(id);
    if (!order || (sellerId && order.sellerId !== sellerId)) throw new Error('Order not found');
    order.paymentStatus = paymentStatus;
    if (paymentReference) order.paymentReference = paymentReference;
    order.updatedAt = new Date().toISOString();
    memoryOrders.set(id, order);
    return order;
  },

  getMemoryStore() {
    return memoryOrders;
  },
};

module.exports = orderService;
