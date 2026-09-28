/**
 * Seller-entered Order Service
 *
 * This service is intentionally separate from automatic checkout. Storefront
 * and bot orders take product prices from the database and become Paid only
 * after a payment-provider webhook. A manual order is a seller's record of a
 * sale made on Instagram, WhatsApp, a phone call, a walk-in, or anywhere else:
 * the authenticated seller is therefore allowed to enter prices and record
 * offline payment.
 *
 * Keeping these paths separate prevents a public buyer or an AI tool from
 * using manual-order privileges as a price/payment override backdoor.
 */

const mongoose = require('mongoose');
const Order = require('../../models/Order');
const { MANUAL_CHANNELS, PAYMENT_METHODS } = require('../../models/Order');
const { nextOrderNumber } = require('../../models/Counter');
const { getEffectivePrice } = require('../../models/Product');
const Customer = require('../../models/Customer');
const customerService = require('../customers/customerService');
const productService = require('../products/productService');
const { sanitize, normalizePhone, isEmail } = require('../../utils/validators');
const logger = require('../../utils/logger');

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const MANUAL_PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function notFound() {
  return httpError('Manual order not found', 404);
}

function amount(value, label, { required = false } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw httpError(`${label} must be a non-negative number`);
  }
  return Math.round(parsed * 100) / 100;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9999) {
    throw httpError(`${label} must be an integer between 1 and 9999`);
  }
  return parsed;
}

function optionalDate(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw httpError(`${label} must be a valid date`);
  return parsed;
}

function validateChoice(value, allowed, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) {
    throw httpError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function cleanCustomer(payload = {}) {
  const name = sanitize(payload.name, 100);
  const rawPhone = String(payload.phone || '').trim();
  const phone = normalizePhone(rawPhone) || rawPhone;

  if (!name || !phone) throw httpError('Customer name and phone number are required');

  const rawEmail = sanitize(payload.email || '', 254).toLowerCase();
  if (rawEmail && !isEmail(rawEmail)) throw httpError('Customer email must be valid');

  return {
    name,
    phone,
    email: rawEmail,
    address: sanitize(payload.address || '', 300),
  };
}

/**
 * Resolve linked catalog items and validate custom/off-catalog items. Prices
 * are seller-supplied here by design, but automatic checkout never calls this.
 */
async function buildItems(sellerId, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw httpError('Order must contain at least one item');
  }
  if (rawItems.length > 100) throw httpError('An order cannot contain more than 100 items');

  const items = [];

  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index] || {};
    const quantity = positiveInteger(raw.quantity, `items[${index}].quantity`);

    if (!raw.productId) {
      const name = sanitize(raw.name, 150);
      if (!name) throw httpError(`items[${index}].name is required for a custom item`);
      const price = amount(raw.price, `items[${index}].price`, { required: true });

      items.push({
        isCustomItem: true,
        name,
        price,
        quantity,
        image: sanitize(raw.image || '', 500),
        subtotal: Math.round(price * quantity * 100) / 100,
      });
      continue;
    }

    const product = await productService.getById(raw.productId, sellerId);
    let variant = null;
    let variantLabel = '';

    if (raw.variantId) {
      variant = (product.variants || []).find((candidate) => candidate.id === raw.variantId);
      if (!variant) throw httpError(`Variant not found for product: ${product.name}`, 404);
      variantLabel = [variant.size, variant.color, variant.sku].filter(Boolean).join(' / ');
    }

    // A seller may enter the actual negotiated price for a manual sale. When
    // omitted, the current catalog/discount price is used as a convenience.
    const suppliedPrice = amount(raw.price, `items[${index}].price`);
    const price = suppliedPrice === undefined ? getEffectivePrice(product, variant) : suppliedPrice;

    items.push({
      productId: String(product.id),
      isCustomItem: false,
      variantId: raw.variantId || undefined,
      variantLabel: variantLabel || undefined,
      name: sanitize(raw.name || product.name, 150),
      price,
      quantity,
      image: sanitize(raw.image || (variant && variant.image) || (product.images && product.images[0]) || '', 500),
      subtotal: Math.round(price * quantity * 100) / 100,
    });
  }

  return items;
}

function inventoryQuantities(items, enabled) {
  const quantities = new Map();
  if (!enabled) return quantities;

  for (const item of items || []) {
    if (!item.productId) continue;
    const key = `${item.productId}::${item.variantId || ''}`;
    const current = quantities.get(key) || {
      productId: item.productId,
      variantId: item.variantId || undefined,
      quantity: 0,
    };
    current.quantity += Number(item.quantity) || 0;
    quantities.set(key, current);
  }
  return quantities;
}

/**
 * Reconcile catalog stock when a seller opts into inventory tracking. Applied
 * deltas are rolled back on error, so an insufficient second item does not
 * leave the first item permanently deducted.
 */
async function reconcileInventory(sellerId, oldItems, oldEnabled, newItems, newEnabled) {
  const before = inventoryQuantities(oldItems, oldEnabled);
  const after = inventoryQuantities(newItems, newEnabled);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const applied = [];

  try {
    for (const key of keys) {
      const oldEntry = before.get(key);
      const newEntry = after.get(key);
      const quantityToDeduct = (newEntry ? newEntry.quantity : 0) - (oldEntry ? oldEntry.quantity : 0);
      if (quantityToDeduct === 0) continue;

      const entry = newEntry || oldEntry;
      await productService.adjustStock(entry.productId, sellerId, quantityToDeduct, entry.variantId);
      applied.push({ ...entry, quantityToDeduct });
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      try {
        await productService.adjustStock(
          entry.productId,
          sellerId,
          -entry.quantityToDeduct,
          entry.variantId
        );
      } catch (rollbackError) {
        logger.error('Manual-order stock rollback failed:', {
          sellerId,
          productId: entry.productId,
          error: rollbackError.message,
        });
      }
    }
    throw error;
  }
}

async function findManualDocument(id, sellerId) {
  if (!id || !mongoose.isValidObjectId(id)) throw notFound();
  const order = await Order.findOne({ _id: id, sellerId, source: 'manual' });
  if (!order) throw notFound();
  return order;
}

async function shiftCustomerMetrics(oldOrder, newCustomerId, newTotal) {
  const oldCustomerId = String(oldOrder.customerId);
  const totalDifference = newTotal - Number(oldOrder.total || 0);

  if (oldCustomerId === String(newCustomerId)) {
    if (totalDifference !== 0) {
      await Customer.updateOne(
        { _id: oldCustomerId, sellerId: oldOrder.sellerId },
        { $inc: { totalSpent: totalDifference } }
      );
    }
    return;
  }

  await Customer.updateOne(
    { _id: oldCustomerId, sellerId: oldOrder.sellerId },
    { $inc: { totalOrders: -1, totalSpent: -Number(oldOrder.total || 0) } }
  );
  await Customer.updateOne(
    { _id: newCustomerId, sellerId: oldOrder.sellerId },
    { $inc: { totalOrders: 1, totalSpent: newTotal }, $set: { lastOrderAt: new Date() } }
  );
}

const manualOrderService = {
  /** Create a seller-entered order from any external sales channel. */
  async create(sellerId, enteredBy, payload = {}) {
    if (!sellerId || !enteredBy) throw httpError('Authenticated seller context is required', 401);

    const customerInput = cleanCustomer({
      ...(payload.customer || {}),
      address: payload.deliveryAddress || (payload.customer && payload.customer.address),
    });
    const items = await buildItems(sellerId, payload.items);
    const subtotal = Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
    const deliveryFee = amount(payload.deliveryFee, 'deliveryFee') || 0;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;
    const sourceChannel = validateChoice(payload.sourceChannel, MANUAL_CHANNELS, 'sourceChannel', 'other');
    const paymentStatus = validateChoice(
      payload.paymentStatus,
      MANUAL_PAYMENT_STATUSES,
      'paymentStatus',
      'Pending'
    );
    const paymentMethod = validateChoice(payload.paymentMethod, PAYMENT_METHODS, 'paymentMethod', 'bank_transfer');
    const orderStatus = validateChoice(payload.orderStatus, ORDER_STATUSES, 'orderStatus', 'Pending');
    const expectedDeliveryDate = optionalDate(payload.expectedDeliveryDate, 'expectedDeliveryDate');
    const inventoryAdjusted = payload.adjustInventory === true;

    const customer = await customerService.upsert(sellerId, customerInput);

    await reconcileInventory(sellerId, [], false, items, inventoryAdjusted);

    let order;
    try {
      order = await Order.create({
        sellerId,
        customerId: customer.id,
        shopperId: customer.shopperId || null,
        customerName: customerInput.name,
        customerPhone: customerInput.phone,
        customerEmail: customerInput.email,
        source: 'manual',
        sourceChannel,
        sourceNote: sanitize(payload.sourceNote || '', 300),
        enteredBy: String(enteredBy),
        orderNumber: await nextOrderNumber(sellerId),
        deliveryAddress: customerInput.address,
        items,
        subtotal,
        deliveryFee,
        total,
        paymentStatus,
        paymentMethod,
        orderStatus,
        paymentReference: sanitize(payload.paymentReference || '', 150),
        paidAt: paymentStatus === 'Paid' ? new Date() : null,
        expectedDeliveryDate,
        notes: sanitize(payload.notes || '', 1000),
        inventoryAdjusted,
      });
    } catch (error) {
      await reconcileInventory(sellerId, items, inventoryAdjusted, [], false);
      throw error;
    }

    try {
      await customerService.incrementOnOrder(customer.id, sellerId, total);
    } catch (error) {
      // The order is already durable; never report a failed creation (and
      // invite a duplicate retry) merely because denormalized CRM totals lag.
      logger.error('Manual-order customer metrics update failed:', {
        orderId: order._id.toString(),
        sellerId,
        error: error.message,
      });
    }

    logger.info('Manual order created:', {
      id: order._id.toString(),
      sellerId,
      sourceChannel,
      total,
    });
    return order.toJSON();
  },

  /**
   * Correct a manually entered order. Automatic orders cannot pass this query.
   * Financial totals are always recomputed from item rows server-side.
   */
  async update(id, sellerId, payload = {}) {
    const order = await findManualDocument(id, sellerId);

    const customerInput = payload.customer
      ? cleanCustomer({
          name: payload.customer.name ?? order.customerName,
          phone: payload.customer.phone ?? order.customerPhone,
          email: payload.customer.email ?? order.customerEmail,
          address:
            payload.deliveryAddress !== undefined
              ? payload.deliveryAddress
              : payload.customer.address ?? order.deliveryAddress,
        })
      : {
          name: order.customerName,
          phone: order.customerPhone,
          email: order.customerEmail || '',
          address:
            payload.deliveryAddress !== undefined
              ? sanitize(payload.deliveryAddress, 300)
              : order.deliveryAddress,
        };

    const customer = payload.customer
      ? await customerService.upsert(sellerId, customerInput)
      : { id: order.customerId, shopperId: order.shopperId };

    const items = payload.items ? await buildItems(sellerId, payload.items) : order.items.map((item) => item.toObject());
    const subtotal = Math.round(items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0) * 100) / 100;
    const deliveryFee =
      payload.deliveryFee !== undefined ? amount(payload.deliveryFee, 'deliveryFee', { required: true }) : order.deliveryFee;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;
    const inventoryAdjusted =
      payload.adjustInventory === undefined ? order.inventoryAdjusted : payload.adjustInventory === true;

    await reconcileInventory(
      sellerId,
      order.items.map((item) => item.toObject()),
      order.inventoryAdjusted,
      items,
      inventoryAdjusted
    );

    const updates = {
      customerId: String(customer.id),
      shopperId: customer.shopperId || null,
      customerName: customerInput.name,
      customerPhone: customerInput.phone,
      customerEmail: customerInput.email,
      deliveryAddress: customerInput.address,
      items,
      subtotal,
      deliveryFee,
      total,
      inventoryAdjusted,
    };

    if (payload.sourceChannel !== undefined) {
      updates.sourceChannel = validateChoice(payload.sourceChannel, MANUAL_CHANNELS, 'sourceChannel', 'other');
    }
    if (payload.sourceNote !== undefined) updates.sourceNote = sanitize(payload.sourceNote, 300);
    if (payload.notes !== undefined) updates.notes = sanitize(payload.notes, 1000);
    if (payload.expectedDeliveryDate !== undefined) {
      updates.expectedDeliveryDate = optionalDate(payload.expectedDeliveryDate, 'expectedDeliveryDate');
    }
    if (payload.orderStatus !== undefined) {
      updates.orderStatus = validateChoice(payload.orderStatus, ORDER_STATUSES, 'orderStatus');
    }

    let updated;
    try {
      updated = await Order.findOneAndUpdate(
        { _id: order._id, sellerId, source: 'manual' },
        { $set: updates },
        { new: true, runValidators: true }
      );
    } catch (error) {
      await reconcileInventory(sellerId, items, inventoryAdjusted, order.items, order.inventoryAdjusted);
      throw error;
    }

    if (!updated) {
      await reconcileInventory(sellerId, items, inventoryAdjusted, order.items, order.inventoryAdjusted);
      throw notFound();
    }

    try {
      await shiftCustomerMetrics(order, customer.id, total);
    } catch (error) {
      logger.error('Manual-order customer metrics correction failed:', {
        orderId: id,
        sellerId,
        error: error.message,
      });
    }

    logger.info('Manual order corrected:', { id, sellerId });
    return updated.toJSON();
  },

  /** Seller-recorded payment; impossible to call for storefront/bot orders. */
  async updatePayment(id, sellerId, payload = {}) {
    const order = await findManualDocument(id, sellerId);
    const paymentStatus = validateChoice(
      payload.paymentStatus,
      MANUAL_PAYMENT_STATUSES,
      'paymentStatus'
    );
    if (!paymentStatus) throw httpError('paymentStatus is required');

    const updates = { paymentStatus };
    if (payload.paymentMethod !== undefined) {
      updates.paymentMethod = validateChoice(payload.paymentMethod, PAYMENT_METHODS, 'paymentMethod');
    }
    if (payload.paymentReference !== undefined) {
      updates.paymentReference = sanitize(payload.paymentReference, 150);
    }
    updates.paidAt = paymentStatus === 'Paid' ? order.paidAt || new Date() : null;

    const updated = await Order.findOneAndUpdate(
      { _id: id, sellerId, source: 'manual' },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) throw notFound();

    logger.info('Manual order payment updated:', { id, sellerId, paymentStatus });
    return updated.toJSON();
  },
};

module.exports = manualOrderService;
module.exports.buildItems = buildItems;
module.exports.reconcileInventory = reconcileInventory;
