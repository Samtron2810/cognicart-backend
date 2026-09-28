/**
 * Buyer (Shopper) Self-Service Data Service
 *
 * Read paths a verified buyer is allowed to use for their OWN data. Ownership
 * is always derived from the session's shopperId, never from a phone/email
 * supplied in the request.
 */

const mongoose = require('mongoose');
const Order = require('../../models/Order');
const Business = require('../../models/Business');
const Customer = require('../../models/Customer');

const HISTORY_LIMIT = 100;

/**
 * Guest orders are backfilled with shopperId only after their exact verified
 * phone+email pair matches. Reads therefore never need an unsafe phone fallback.
 */
function ownershipFilter(shopper) {
  return { shopperId: shopper._id.toString() };
}

function presentOrder(order, storesBySeller) {
  const json = order.toJSON();
  const store = storesBySeller.get(json.sellerId);

  // Internal bookkeeping the buyer has no use for
  delete json.idempotencyKey;
  delete json.customerId;
  delete json.shopperId;

  return {
    ...json,
    store: store ? { name: store.name, slug: store.slug, phone: store.phone || '' } : null,
  };
}

async function loadStores(sellerIds) {
  if (sellerIds.length === 0) return new Map();
  const businesses = await Business.find({ sellerId: { $in: sellerIds } });
  return new Map(businesses.map((b) => [b.sellerId, b.toJSON()]));
}

const shopperService = {
  /**
   * Buyer profile plus the stores they have bought from.
   */
  async getProfile(shopper) {
    const customers = await Customer.find({ shopperId: shopper._id.toString() });

    const stores = await loadStores([...new Set(customers.map((c) => c.sellerId))]);

    return {
      ...shopper.toJSON(),
      stores: [...stores.values()].map((s) => ({ sellerId: s.sellerId, name: s.name, slug: s.slug })),
      totalOrders: customers.reduce((sum, c) => sum + (c.totalOrders || 0), 0),
      totalSpent: customers.reduce((sum, c) => sum + (c.totalSpent || 0), 0),
      addresses: [...new Set(customers.flatMap((c) => c.addresses || []))],
    };
  },

  /**
   * Cross-store purchase history, newest first.
   */
  async listOrders(shopper, { sellerId, status, paymentStatus } = {}) {
    const filter = ownershipFilter(shopper);
    if (sellerId) filter.sellerId = sellerId;
    if (status) filter.orderStatus = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(HISTORY_LIMIT);
    const stores = await loadStores([...new Set(orders.map((o) => o.sellerId))]);

    return orders.map((o) => presentOrder(o, stores));
  },

  /**
   * A single order, only if it belongs to this buyer.
   */
  async getOrderById(shopper, id) {
    const notFound = () => {
      const err = new Error('Order not found');
      err.statusCode = 404;
      return err;
    };

    if (!id || !mongoose.isValidObjectId(id)) throw notFound();

    const order = await Order.findOne({ _id: id, ...ownershipFilter(shopper) });
    if (!order) throw notFound();

    const stores = await loadStores([order.sellerId]);
    return presentOrder(order, stores);
  },
};

module.exports = shopperService;
