/**
 * Customer Management Service
 * Multi-tenant customer profiles, address book, and lifetime purchasing metrics
 */

const mongoose = require('mongoose');
const Customer = require('../../models/Customer');
const { sanitize, escapeRegex, normalizePhone, isEmail } = require('../../utils/validators');
const logger = require('../../utils/logger');

function notFound(message = 'Customer not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!isEmail(email)) {
    const err = new Error('Customer email must be valid');
    err.statusCode = 400;
    throw err;
  }
  return email;
}

const customerService = {
  /**
   * List customers for a specific seller
   */
  async list(sellerId, { search } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const filter = { sellerId };
    if (search) {
      const q = escapeRegex(sanitize(search, 100));
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
      ];
    }

    const customers = await Customer.find(filter).sort({ lastOrderAt: -1, createdAt: -1 });
    return customers.map((c) => c.toJSON());
  },

  /**
   * Get customer by ID (enforcing tenant isolation)
   */
  async getById(id, sellerId) {
    if (!id || !mongoose.isValidObjectId(id)) throw notFound();

    const customer = await Customer.findOne({ _id: id, sellerId });
    if (!customer) throw notFound();

    return customer.toJSON();
  },

  /**
   * Find customer by phone under a seller
   */
  async findByPhone(phone, sellerId) {
    if (!phone) return null;
    const cleanPhone = normalizePhone(phone);

    const customer = await Customer.findOne({
      sellerId,
      $or: [{ phone: cleanPhone }, { phone: String(phone).trim() }],
    });

    return customer ? customer.toJSON() : null;
  },

  /**
   * Create a new customer profile
   */
  async create(sellerId, payload) {
    const name = sanitize(payload.name, 100);
    const phone = normalizePhone(payload.phone) || String(payload.phone || '').trim();
    const address = payload.address ? sanitize(payload.address, 300) : '';

    const customer = await Customer.create({
      sellerId,
      shopperId: payload.shopperId || null,
      name,
      phone,
      email: normalizeEmail(payload.email),
      addresses: address ? [address] : [],
      totalOrders: 0,
      totalSpent: 0,
      lastOrderAt: null,
    });

    logger.info('Customer created:', { id: customer._id.toString(), sellerId, name });
    return customer.toJSON();
  },

  /**
   * Upsert customer by phone: update addresses or create new
   */
  async upsert(sellerId, payload) {
    const cleanPhone = normalizePhone(payload.phone) || String(payload.phone || '').trim();
    const cleanEmail = normalizeEmail(payload.email);

    // Email is now a storefront identity boundary. Two people can legitimately
    // share a phone (family/business line), and a forged checkout must not
    // overwrite the email on an existing CRM identity.
    let existing;
    if (cleanEmail) {
      const document = await Customer.findOne({ sellerId, phone: cleanPhone, email: cleanEmail });
      existing = document ? document.toJSON() : null;
    } else {
      existing = await this.findByPhone(cleanPhone, sellerId);
    }

    if (existing) {
      const newAddress = payload.address ? sanitize(payload.address, 300) : '';
      const updates = {};

      if (newAddress && !(existing.addresses || []).includes(newAddress)) {
        updates.$addToSet = { addresses: newAddress };
      }
      const set = {};
      // Link the CRM record to the buyer identity the first time we learn it
      if (payload.shopperId && !existing.shopperId) set.shopperId = payload.shopperId;

      const newName = payload.name ? sanitize(payload.name, 100) : '';
      if (newName && newName !== existing.name) set.name = newName;

      const newEmail = normalizeEmail(payload.email);
      if (newEmail && newEmail !== existing.email) set.email = newEmail;

      if (Object.keys(set).length) updates.$set = set;
      if (Object.keys(updates).length === 0) return existing;

      const updated = await Customer.findByIdAndUpdate(existing.id, updates, { new: true });
      return updated ? updated.toJSON() : existing;
    }
    return this.create(sellerId, payload);
  },

  /** Find a CRM profile by channel identity (e.g. Telegram user id). */
  async findByIdentity(sellerId, channel, externalId) {
    if (!sellerId || !channel || !externalId) return null;
    const customer = await Customer.findOne({
      sellerId,
      identities: { $elemMatch: { channel, externalId: String(externalId) } },
    });
    return customer ? customer.toJSON() : null;
  },

  /** Create/update a customer as soon as they start a channel conversation. */
  async upsertChannelIdentity(sellerId, { channel, externalId, handle = '', displayName = '' }) {
    if (!sellerId || !channel || !externalId) {
      const err = new Error('Seller, channel, and external identity are required');
      err.statusCode = 400;
      throw err;
    }

    const id = String(externalId);
    const existing = await Customer.findOne({
      sellerId,
      identities: { $elemMatch: { channel, externalId: id } },
    });

    if (existing) {
      const identity = existing.identities.find(
        (item) => item.channel === channel && item.externalId === id
      );
      if (identity) {
        identity.handle = sanitize(handle, 100);
        identity.displayName = sanitize(displayName, 100);
      }
      if (displayName) existing.name = sanitize(displayName, 100);
      await existing.save();
      return existing.toJSON();
    }

    const customer = await Customer.create({
      sellerId,
      name: sanitize(displayName, 100) || `${channel} customer`,
      phone: '',
      email: '',
      identities: [{
        channel,
        externalId: id,
        handle: sanitize(handle, 100),
        displayName: sanitize(displayName, 100),
      }],
    });
    return customer.toJSON();
  },

  /**
   * Attach a phone shared by the channel account owner. This intentionally does
   * not claim a same-phone storefront row, whose email identity is unproven.
   */
  async attachPhoneToIdentity(sellerId, { channel, externalId, phone, handle = '', displayName = '' }) {
    const cleanPhone = normalizePhone(phone) || String(phone || '').trim();
    if (!cleanPhone) {
      const err = new Error('A valid phone number is required');
      err.statusCode = 400;
      throw err;
    }

    const channelCustomer = await Customer.findOne({
      sellerId,
      identities: { $elemMatch: { channel, externalId: String(externalId) } },
    });
    if (!channelCustomer) {
      await this.upsertChannelIdentity(sellerId, { channel, externalId, handle, displayName });
      return this.attachPhoneToIdentity(sellerId, { channel, externalId, phone: cleanPhone, handle, displayName });
    }

    const identity = {
      handle: sanitize(handle, 100),
      displayName: sanitize(displayName, 100),
    };

    channelCustomer.phone = cleanPhone;
    if (displayName) channelCustomer.name = sanitize(displayName, 100);
    const currentIdentity = channelCustomer.identities.find(
      (item) => item.channel === channel && item.externalId === String(externalId)
    );
    if (currentIdentity) {
      currentIdentity.handle = identity.handle;
      currentIdentity.displayName = identity.displayName;
    }
    await channelCustomer.save();
    return channelCustomer.toJSON();
  },

  async refreshByIdentity(sellerId, channel, externalId, payload = {}) {
    const customer = await Customer.findOne({
      sellerId,
      identities: { $elemMatch: { channel, externalId: String(externalId) } },
    });
    if (!customer) return null;
    if (payload.name) customer.name = sanitize(payload.name, 100);
    if (payload.phone) customer.phone = normalizePhone(payload.phone) || String(payload.phone).trim();
    const address = payload.address ? sanitize(payload.address, 300) : '';
    if (address && !customer.addresses.includes(address)) customer.addresses.push(address);
    await customer.save();
    return customer.toJSON();
  },

  async setOptOutByIdentity(sellerId, channel, externalId, optOut = true) {
    const customer = await Customer.findOneAndUpdate(
      {
        sellerId,
        identities: { $elemMatch: { channel, externalId: String(externalId) } },
      },
      { $set: { marketingOptOut: !!optOut } },
      { new: true }
    );
    return customer ? customer.toJSON() : null;
  },

  /**
   * Increment purchasing metrics when an order is created
   */
  async incrementOnOrder(customerId, sellerId, amount) {
    if (!customerId || !mongoose.isValidObjectId(customerId)) return;

    await Customer.findOneAndUpdate(
      { _id: customerId, sellerId },
      {
        $inc: { totalOrders: 1, totalSpent: amount },
        $set: { lastOrderAt: new Date() },
      }
    );
  },

  /**
   * Update marketing opt-out preference
   */
  async setOptOut(phone, sellerId, optOut = true) {
    if (!phone) return null;
    const cleanPhone = normalizePhone(phone);

    const updated = await Customer.findOneAndUpdate(
      { sellerId, $or: [{ phone: cleanPhone }, { phone: String(phone).trim() }] },
      { $set: { marketingOptOut: !!optOut } },
      { new: true }
    );

    return updated ? updated.toJSON() : null;
  },
};

module.exports = customerService;
