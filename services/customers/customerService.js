/**
 * Customer Management Service
 * Multi-tenant customer profiles, address book, and lifetime purchasing metrics
 */

const Customer = require('../../models/Customer');
const { isDbConnected } = require('../../config/db');
const { sanitize, normalizePhone } = require('../../utils/validators');
const logger = require('../../utils/logger');

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryCustomers = new Map();

const customerService = {
  /**
   * List customers for a specific seller
   */
  async list(sellerId, { search } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (isDbConnected()) {
      const filter = { sellerId };
      if (search) {
        const q = sanitize(search, 100);
        filter.$or = [
          { name: { $regex: q, $options: 'i' } },
          { phone: { $regex: q, $options: 'i' } },
          { whatsappId: { $regex: q, $options: 'i' } },
        ];
      }
      const customers = await Customer.find(filter).sort({ lastOrderAt: -1, createdAt: -1 });
      return customers.map((c) => c.toJSON());
    }

    // In-memory fallback
    let list = Array.from(memoryCustomers.values()).filter((c) => c.sellerId === sellerId);
    if (search) {
      const q = sanitize(search, 100).toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phone.includes(q) ||
          (c.whatsappId && c.whatsappId.toLowerCase().includes(q))
      );
    }
    return list.sort((a, b) => new Date(b.lastOrderAt || b.createdAt).getTime() - new Date(a.lastOrderAt || a.createdAt).getTime());
  },

  /**
   * Get customer by ID (enforcing tenant isolation)
   */
  async getById(id, sellerId) {
    if (isDbConnected()) {
      const customer = await Customer.findOne({ _id: id, sellerId });
      if (!customer) {
        const err = new Error('Customer not found');
        err.statusCode = 404;
        throw err;
      }
      return customer.toJSON();
    }

    const customer = memoryCustomers.get(id);
    if (!customer || customer.sellerId !== sellerId) {
      const err = new Error('Customer not found');
      err.statusCode = 404;
      throw err;
    }
    return customer;
  },

  /**
   * Find customer by phone under a seller
   */
  async findByPhone(phone, sellerId) {
    const cleanPhone = normalizePhone(phone);
    if (isDbConnected()) {
      const customer = await Customer.findOne({
        sellerId,
        $or: [{ phone: cleanPhone }, { phone: phone.trim() }],
      });
      return customer ? customer.toJSON() : null;
    }

    const list = Array.from(memoryCustomers.values()).filter((c) => c.sellerId === sellerId);
    return list.find((c) => c.phone === cleanPhone || c.phone === phone.trim()) || null;
  },

  /**
   * Create a new customer profile
   */
  async create(sellerId, payload) {
    const name = sanitize(payload.name, 100);
    const phone = normalizePhone(payload.phone) || payload.phone.trim();
    const whatsappId = payload.whatsappId ? normalizePhone(payload.whatsappId) : phone;
    const address = payload.address ? sanitize(payload.address, 300) : '';

    const customerData = {
      sellerId,
      name,
      phone,
      whatsappId,
      email: (payload.email || '').trim().toLowerCase(),
      addresses: address ? [address] : [],
      totalOrders: 0,
      totalSpent: 0,
      lastOrderAt: null,
    };

    if (isDbConnected()) {
      const customer = await Customer.create(customerData);
      logger.info('Customer created (DB):', { id: customer._id.toString(), sellerId, name });
      return customer.toJSON();
    }

    const id = 'cust_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const memCustomer = {
      id,
      _id: id,
      ...customerData,
      createdAt: now,
      updatedAt: now,
    };
    memoryCustomers.set(id, memCustomer);
    logger.info('Customer created (Memory):', { id, sellerId, name });
    return memCustomer;
  },

  /**
   * Upsert customer by phone: update addresses or create new
   */
  async upsert(sellerId, payload) {
    const existing = await this.findByPhone(payload.phone, sellerId);
    if (existing) {
      const newAddress = payload.address ? sanitize(payload.address, 300) : '';
      if (newAddress && !existing.addresses.includes(newAddress)) {
        if (isDbConnected()) {
          const updated = await Customer.findByIdAndUpdate(
            existing.id,
            { $addToSet: { addresses: newAddress }, $set: { updatedAt: new Date() } },
            { new: true }
          );
          return updated.toJSON();
        }
        existing.addresses.push(newAddress);
        existing.updatedAt = new Date().toISOString();
        memoryCustomers.set(existing.id, existing);
      }
      return existing;
    }
    return this.create(sellerId, payload);
  },

  /**
   * Increment purchasing metrics when an order is created
   */
  async incrementOnOrder(customerId, sellerId, amount) {
    const now = new Date();
    if (isDbConnected()) {
      await Customer.findOneAndUpdate(
        { _id: customerId, sellerId },
        {
          $inc: { totalOrders: 1, totalSpent: amount },
          $set: { lastOrderAt: now },
        }
      );
      return;
    }

    const c = memoryCustomers.get(customerId);
    if (c && c.sellerId === sellerId) {
      c.totalOrders += 1;
      c.totalSpent += amount;
      c.lastOrderAt = now.toISOString();
      c.updatedAt = now.toISOString();
      memoryCustomers.set(customerId, c);
    }
  },

  /**
   * Update marketing opt-out preference
   */
  async setOptOut(phone, sellerId, optOut = true) {
    const cleanPhone = normalizePhone(phone);
    if (isDbConnected()) {
      const query = { sellerId, $or: [{ phone: cleanPhone }, { phone: phone.trim() }] };
      const updated = await Customer.findOneAndUpdate(
        query,
        { $set: { marketingOptOut: !!optOut, updatedAt: new Date() } },
        { new: true }
      );
      return updated ? updated.toJSON() : null;
    }

    const list = Array.from(memoryCustomers.values()).filter((c) => c.sellerId === sellerId);
    const c = list.find((cust) => cust.phone === cleanPhone || cust.phone === phone.trim());
    if (c) {
      c.marketingOptOut = !!optOut;
      c.updatedAt = new Date().toISOString();
      memoryCustomers.set(c.id, c);
      return c;
    }
    return null;
  },

  getMemoryStore() {
    return memoryCustomers;
  },
};

module.exports = customerService;
