/**
 * Multi-Seller Checkout Service
 *
 * Turns one basket spanning several stores into one parent OrderGroup plus
 * one normal single-seller Order per store.
 *
 * The important design choice is that the sub-orders are created by the
 * existing `orderService.create`, not by new code. That is what keeps stock
 * reservation, per-seller order numbering, customer linking, pricing
 * authority and seller notifications identical to a single-store checkout —
 * and it is why the seller dashboard needs no changes at all: a sub-order is
 * just an order, already filtered by sellerId everywhere it is read.
 *
 * Partial failure is the thing to get right. If store B's order fails after
 * store A's succeeded, the buyer must not end up owning a half-basket they
 * did not agree to buy. Everything created so far is rolled back, releasing
 * the reserved stock, before the error is re-thrown.
 */

const mongoose = require('mongoose');
const Order = require('../../models/Order');
const OrderGroup = require('../../models/OrderGroup');
const Business = require('../../models/Business');
const orderService = require('./orderService');
const { nextSequence } = require('../../models/Counter');
const logger = require('../../utils/logger');

/** A, B, C … for sub-order labels. Beyond 26 stores it falls back to a number. */
function labelFor(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Group cart lines by seller, preserving the order the buyer added them in
 * so the A/B/C labels are stable rather than arbitrary.
 */
function groupItemsBySeller(items) {
  const bySeller = new Map();
  for (const item of items) {
    const sellerId = String(item.sellerId || '').trim();
    if (!sellerId) throw httpError('Every cart item must carry a sellerId');
    if (!item.productId) throw httpError('Every cart item must carry a productId');
    if (!bySeller.has(sellerId)) bySeller.set(sellerId, []);
    bySeller.get(sellerId).push({
      productId: item.productId,
      variantId: item.variantId,
      quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
    });
  }
  return bySeller;
}

const orderGroupService = {
  /**
   * Create a multi-seller order group.
   *
   * @param {object} payload
   * @param {object} payload.customer  { name, phone, email, address }
   * @param {Array}  payload.items     [{ sellerId, productId, variantId, quantity }]
   * @param {string} [payload.deliveryAddress]
   * @param {object} [options]
   * @param {string} [options.shopperId]
   * @param {string} [options.idempotencyKey]
   */
  async create(payload = {}, options = {}) {
    const { customer, items } = payload;

    if (!customer || !customer.name || !customer.phone) {
      throw httpError('Customer name and phone number are required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw httpError('Your cart is empty');
    }

    const idempotencyKey = options.idempotencyKey || '';

    // Replaying the same submission must return the same group, never a
    // second set of orders against the same stock.
    if (idempotencyKey) {
      const existing = await OrderGroup.findOne({ idempotencyKey });
      if (existing) {
        logger.info('Idempotent order group hit:', { idempotencyKey, groupId: existing._id.toString() });
        return existing.toJSON();
      }
    }

    const bySeller = groupItemsBySeller(items);
    const sellerIds = [...bySeller.keys()];
    const deliveryAddress = payload.deliveryAddress || customer.address || '';

    // Delivery is charged per seller because `Business.deliveryFee` is a
    // per-seller setting: three stores genuinely means three deliveries, and
    // the breakdown is returned so the UI can show that rather than hide it.
    const businesses = await Business.find({ sellerId: { $in: sellerIds } })
      .select('sellerId name deliveryFee freeDeliveryThreshold')
      .lean();
    const storeById = new Map(businesses.map((business) => [String(business.sellerId), business]));

    const missing = sellerIds.filter((sellerId) => !storeById.has(sellerId));
    if (missing.length) throw httpError('One of the stores in your cart is no longer available', 404);

    const createdOrders = [];
    const lines = [];

    try {
      let index = 0;
      for (const sellerId of sellerIds) {
        const store = storeById.get(sellerId);
        // Sub-keys keep each sub-order independently idempotent, so a retry
        // after a mid-way failure cannot duplicate the orders that did land.
        const subKey = idempotencyKey ? `${idempotencyKey}:${sellerId}` : undefined;

        const order = await orderService.create(
          sellerId,
          {
            customer,
            items: bySeller.get(sellerId),
            deliveryAddress,
          },
          subKey,
          { source: 'storefront' }
        );

        createdOrders.push(order);
        lines.push({
          sellerId,
          orderId: order.id,
          label: labelFor(index),
          storeName: store.name || '',
          subtotal: Number(order.subtotal) || 0,
          deliveryFee: Number(order.deliveryFee) || 0,
          total: Number(order.total) || 0,
        });
        index += 1;
      }
    } catch (error) {
      // Roll back every sub-order already created. Leaving them would charge
      // the buyer's stock reservation for a basket that was never placed.
      await this.rollback(createdOrders, error);
      throw error;
    }

    const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
    const deliveryTotal = lines.reduce((sum, line) => sum + line.deliveryFee, 0);
    const grandTotal = lines.reduce((sum, line) => sum + line.total, 0);

    const groupNumber = await nextSequence('ordergroup');

    let group;
    try {
      group = await OrderGroup.create({
        groupNumber,
        shopperId: options.shopperId || null,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerEmail: String(customer.email || '').trim().toLowerCase(),
        deliveryAddress,
        orders: lines,
        sellerIds,
        subtotal,
        deliveryTotal,
        grandTotal,
        idempotencyKey: idempotencyKey || undefined,
      });
    } catch (error) {
      await this.rollback(createdOrders, error);
      throw error;
    }

    // Stamp the parent back onto each sub-order so a seller opening one can
    // see it is part of a larger basket without seeing the rest of it.
    const reference = `ORD-${groupNumber}`;
    await Promise.all(
      lines.map((line) =>
        Order.updateOne(
          { _id: line.orderId, sellerId: line.sellerId },
          { $set: { parentOrderId: group._id.toString(), groupLabel: `${reference}-${line.label}` } }
        ).catch((error) =>
          // Non-fatal: the group already records the link in both directions.
          logger.warn('Could not stamp group label on sub-order', { orderId: line.orderId, error: error.message })
        )
      )
    );

    logger.info('Order group created:', { reference, sellers: sellerIds.length, grandTotal });
    return group.toJSON();
  },

  /**
   * Cancel sub-orders created before a failure, releasing their stock.
   * Best effort by design: one failed rollback must not mask the original
   * error, which is the thing the caller actually needs to see.
   */
  async rollback(orders, cause) {
    if (!orders.length) return;
    logger.warn('Rolling back partial order group', {
      orders: orders.length,
      reason: cause && cause.message,
    });

    for (const order of orders) {
      try {
        // cancel() is the path that restores reserved stock, exactly once.
        await orderService.cancel(order.id, order.sellerId, {
          cancelledBy: 'system',
          reason: 'Multi-store checkout could not be completed',
        });
      } catch (error) {
        logger.error('Could not roll back sub-order; needs manual review', {
          orderId: order.id,
          sellerId: order.sellerId,
          error: error.message,
        });
      }
    }
  },

  /** Load a group by id or by its ORD-1042 reference. */
  async getById(id) {
    if (!id) throw httpError('Order group id is required');

    let group = null;
    if (mongoose.isValidObjectId(id)) {
      group = await OrderGroup.findById(id);
    }
    if (!group) {
      const numeric = Number(String(id).replace(/^ORD-/i, ''));
      if (Number.isSafeInteger(numeric) && numeric > 0) {
        group = await OrderGroup.findOne({ groupNumber: numeric });
      }
    }
    if (!group) throw httpError('Order group not found', 404);
    return group;
  },

  /**
   * The buyer-facing view: the parent plus every sub-order in full.
   * Only ever called with the buyer's own identity, never a seller's.
   */
  async getForBuyer(id, { shopperId, email } = {}) {
    const group = await this.getById(id);

    const ownsByShopper = shopperId && String(group.shopperId || '') === String(shopperId);
    const ownsByEmail = email && group.customerEmail && group.customerEmail === String(email).toLowerCase();
    if (!ownsByShopper && !ownsByEmail) throw httpError('Order group not found', 404);

    const orders = await Order.find({ parentOrderId: group._id.toString() }).lean();
    const byId = new Map(orders.map((order) => [String(order._id), order]));

    return {
      ...group.toJSON(),
      orders: group.orders.map((line) => {
        const order = byId.get(String(line.orderId));
        return {
          ...line.toObject(),
          orderStatus: order ? order.orderStatus : 'Pending',
          paymentStatus: order ? order.paymentStatus : 'Pending',
          items: order ? order.items : [],
        };
      }),
    };
  },

  labelFor,
  groupItemsBySeller,
};

module.exports = orderGroupService;
