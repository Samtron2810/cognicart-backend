/**
 * Admin Broadcast Service
 *
 * Bulk email from the platform to its sellers. Three rules shape this file:
 *
 *  1. Resolve the audience ONCE, snapshot it, then send. Resolving per batch
 *     would let a mid-send signup join a half-delivered audience.
 *  2. A per-recipient failure never aborts the run - it marks that row and the
 *     loop continues, mirroring the dispatcher's failure-isolation contract.
 *  3. This is MARKETING mail, so `marketingOptOut` is always honoured. It must
 *     never suppress transactional mail (OTP, password reset, order updates).
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const AdminBroadcast = require('../../models/AdminBroadcast');
const User = require('../../models/User');
const Business = require('../../models/Business');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const { isEmail, sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

const SECRET = process.env.JWT_SECRET || 'wabac_jwt_super_secret_dev_key_2026';

/** Blast-radius cap: one mistake should not reach the whole platform twice over. */
const MAX_RECIPIENTS = Number(process.env.BROADCAST_MAX_RECIPIENTS || 2000);
/** Gap between send chunks, so Brevo is not hammered. */
const SEND_DELAY_MS = Number(process.env.BROADCAST_EMAIL_DELAY_MS || 250);
const CHUNK_SIZE = 10;

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function notFound(message = 'Broadcast not found') {
  return badRequest(message, 404);
}

function getNotificationService() {
  // Lazy: avoids a load-order cycle with the notification layer.
  return require('../notifications/notificationService');
}

function clientUrl() {
  return (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueEmails(list) {
  return [...new Set((list || []).map(cleanEmail).filter((email) => isEmail(email)))];
}

/* -------------------------------------------------------------------------- */
/* Unsubscribe tokens                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Stateless, signed, no expiry. One-click unsubscribe must work without a
 * login - a link that demands a password is not a working opt-out.
 */
function unsubscribeToken(userId) {
  const id = String(userId);
  const signature = crypto.createHmac('sha256', SECRET).update(`unsub:${id}`).digest('hex').slice(0, 32);
  return `${id}.${signature}`;
}

function verifyUnsubscribeToken(token) {
  const [id, signature] = String(token || '').split('.');
  if (!id || !signature) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(`unsub:${id}`).digest('hex').slice(0, 32);
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function unsubscribeUrl(userId) {
  return `${clientUrl()}/unsubscribe?t=${unsubscribeToken(userId)}`;
}

/* -------------------------------------------------------------------------- */
/* Audience resolution                                                        */
/* -------------------------------------------------------------------------- */

/** Segments whose definition needs a rollup from another collection. */
async function sellerIdsWithProducts() {
  const rows = await Product.aggregate([{ $group: { _id: '$sellerId' } }]);
  return new Set(rows.map((r) => String(r._id)));
}

async function sellerIdsWithSales() {
  const rows = await Order.aggregate([
    { $match: { paymentStatus: 'Paid' } },
    { $group: { _id: '$sellerId' } },
  ]);
  return new Set(rows.map((r) => String(r._id)));
}

async function sellerIdsWithRecentOrders(days) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await Order.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$sellerId' } },
  ]);
  return new Set(rows.map((r) => String(r._id)));
}

async function connectedSellerIds() {
  const rows = await Business.find({ telegramConnected: true }).select('sellerId').lean();
  return new Set(rows.map((r) => String(r.sellerId)));
}

/**
 * Resolve the selected segments into account rows.
 * Segments are a UNION: picking UNVERIFIED and SUSPENDED mails both groups.
 */
async function resolveSegmentUsers(segments, segmentDays) {
  if (!segments || segments.length === 0) return [];

  const days = Math.min(Math.max(Number(segmentDays) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);

  // Base pool: sellers, unless ADMINS is explicitly requested.
  const wantsAdmins = segments.includes('ADMINS');
  const sellerSegments = segments.filter((segment) => segment !== 'ADMINS');

  const collected = new Map();

  if (sellerSegments.length > 0) {
    const sellers = await User.find({ role: 'seller' })
      .select('businessName email isActive isEmailVerified marketingOptOut createdAt')
      .lean();

    // Only compute the expensive rollups a chosen segment actually needs.
    const needsProducts = sellerSegments.includes('NO_PRODUCTS');
    const needsSales = sellerSegments.includes('HAS_SALES') || sellerSegments.includes('NO_SALES');
    const needsDormant = sellerSegments.includes('DORMANT');
    const needsTelegram =
      sellerSegments.includes('TELEGRAM_CONNECTED') || sellerSegments.includes('TELEGRAM_NOT_CONNECTED');

    const [withProducts, withSales, withRecentOrders, connected] = await Promise.all([
      needsProducts ? sellerIdsWithProducts() : Promise.resolve(new Set()),
      needsSales ? sellerIdsWithSales() : Promise.resolve(new Set()),
      needsDormant ? sellerIdsWithRecentOrders(days) : Promise.resolve(new Set()),
      needsTelegram ? connectedSellerIds() : Promise.resolve(new Set()),
    ]);

    const matches = (user, segment) => {
      const id = user._id.toString();
      switch (segment) {
        case 'ALL_SELLERS':
          return true;
        case 'VERIFIED':
          return user.isEmailVerified === true;
        case 'UNVERIFIED':
          return user.isEmailVerified !== true;
        case 'ACTIVE':
          return user.isActive !== false;
        case 'SUSPENDED':
          return user.isActive === false;
        case 'TELEGRAM_CONNECTED':
          return connected.has(id);
        case 'TELEGRAM_NOT_CONNECTED':
          return !connected.has(id);
        case 'NO_PRODUCTS':
          return !withProducts.has(id);
        case 'HAS_SALES':
          return withSales.has(id);
        case 'NO_SALES':
          return !withSales.has(id);
        case 'NEW_SIGNUPS':
          return user.createdAt && new Date(user.createdAt) >= since;
        case 'DORMANT':
          return !withRecentOrders.has(id);
        default:
          return false;
      }
    };

    for (const user of sellers) {
      if (sellerSegments.some((segment) => matches(user, segment))) {
        collected.set(user._id.toString(), user);
      }
    }
  }

  if (wantsAdmins) {
    const admins = await User.find({ role: { $in: ['admin', 'platform_owner'] } })
      .select('businessName email isActive isEmailVerified marketingOptOut createdAt')
      .lean();
    admins.forEach((user) => collected.set(user._id.toString(), user));
  }

  return [...collected.values()];
}

/**
 * Build the final recipient list: segments ∪ typed addresses, minus
 * exclusions, minus opt-outs, de-duplicated by email.
 */
async function resolveAudience({ segments = [], segmentDays = 30, includeEmails = [], excludeEmails = [] }) {
  const users = await resolveSegmentUsers(segments, segmentDays);

  const excluded = new Set(uniqueEmails(excludeEmails));
  const byEmail = new Map();
  let optedOut = 0;

  for (const user of users) {
    const email = cleanEmail(user.email);
    if (!isEmail(email) || excluded.has(email)) continue;
    if (user.marketingOptOut === true) {
      optedOut += 1;
      continue;
    }
    byEmail.set(email, {
      userId: user._id.toString(),
      email,
      businessName: user.businessName || '',
      adHoc: false,
      status: 'pending',
    });
  }

  // Typed addresses. Match them to an account when one exists, so the email
  // can still be personalised and carry a working unsubscribe link.
  const typed = uniqueEmails(includeEmails).filter((email) => !excluded.has(email));
  if (typed.length > 0) {
    const known = await User.find({ email: { $in: typed } })
      .select('businessName email marketingOptOut')
      .lean();
    const knownByEmail = new Map(known.map((u) => [cleanEmail(u.email), u]));

    for (const email of typed) {
      if (byEmail.has(email)) continue;
      const user = knownByEmail.get(email);
      if (user && user.marketingOptOut === true) {
        optedOut += 1;
        continue;
      }
      byEmail.set(email, {
        userId: user ? user._id.toString() : '',
        email,
        businessName: user ? user.businessName || '' : '',
        adHoc: !user,
        status: 'pending',
      });
    }
  }

  return { recipients: [...byEmail.values()], optedOut };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function interpolate(text, recipient) {
  const businessName = recipient.businessName || 'there';
  return String(text || '')
    .replace(/{{\s*businessName\s*}}|{{\s*business_name\s*}}/gi, businessName)
    .replace(/{{\s*firstName\s*}}|{{\s*first_name\s*}}/gi, String(businessName).split(' ')[0])
    .replace(/{{\s*email\s*}}/gi, recipient.email);
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

function validatePayload(payload) {
  const subject = sanitize(payload.subject || '', 150);
  if (subject.length < 3) throw badRequest('Subject must be at least 3 characters');

  const body = String(payload.body || '').trim();
  if (body.length < 10) throw badRequest('Message body must be at least 10 characters');
  if (body.length > 5000) throw badRequest('Message cannot exceed 5000 characters');

  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const invalid = segments.filter((segment) => !AdminBroadcast.SEGMENTS.includes(segment));
  if (invalid.length > 0) throw badRequest(`Unknown segment(s): ${invalid.join(', ')}`);

  const includeEmails = uniqueEmails(payload.includeEmails);
  const excludeEmails = uniqueEmails(payload.excludeEmails);

  if (segments.length === 0 && includeEmails.length === 0) {
    throw badRequest('Choose at least one audience segment or enter a recipient address');
  }

  const ctaUrl = String(payload.ctaUrl || '').trim();
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) {
    throw badRequest('Button link must start with http:// or https://');
  }
  if (ctaUrl && !String(payload.ctaLabel || '').trim()) {
    throw badRequest('Give the button a label, or remove the link');
  }

  return {
    subject,
    body,
    preheader: sanitize(payload.preheader || '', 150),
    ctaLabel: sanitize(payload.ctaLabel || '', 60),
    ctaUrl,
    segments,
    segmentDays: Number(payload.segmentDays) || 30,
    includeEmails,
    excludeEmails,
  };
}

const adminBroadcastService = {
  MAX_RECIPIENTS,

  /** Dry run: how many people would this reach, and who are the first few? */
  async preview(payload) {
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const { recipients, optedOut } = await resolveAudience({
      segments,
      segmentDays: payload.segmentDays,
      includeEmails: payload.includeEmails,
      excludeEmails: payload.excludeEmails,
    });

    return {
      count: recipients.length,
      optedOut,
      adHoc: recipients.filter((r) => r.adHoc).length,
      overLimit: recipients.length > MAX_RECIPIENTS,
      maxRecipients: MAX_RECIPIENTS,
      sample: recipients.slice(0, 10).map((r) => r.email),
    };
  },

  async create(payload, actor) {
    const clean = validatePayload(payload);

    const broadcast = await AdminBroadcast.create({
      ...clean,
      status: 'draft',
      createdBy: actor.id,
      createdByEmail: actor.email,
    });

    logger.info('Admin broadcast drafted:', { id: broadcast._id.toString(), by: actor.email });
    return broadcast.toJSON();
  },

  async update(id, payload) {
    const broadcast = await this.getDoc(id);
    if (broadcast.status !== 'draft') throw badRequest('Only a draft can be edited');

    Object.assign(broadcast, validatePayload(payload));
    await broadcast.save();
    return broadcast.toJSON();
  },

  async list({ limit = 50 } = {}) {
    const rows = await AdminBroadcast.find()
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      // The recipient array can be thousands of rows; never ship it in a list.
      .select('-recipients')
      .lean();

    return rows.map((row) => ({ ...row, id: row._id.toString(), _id: undefined }));
  },

  async getDoc(id) {
    if (!mongoose.isValidObjectId(id)) throw notFound();
    const broadcast = await AdminBroadcast.findById(id);
    if (!broadcast) throw notFound();
    return broadcast;
  },

  async getById(id) {
    const broadcast = await this.getDoc(id);
    return broadcast.toJSON();
  },

  async remove(id) {
    const broadcast = await this.getDoc(id);
    if (broadcast.status === 'sending') throw badRequest('Cannot delete a broadcast that is sending');
    await AdminBroadcast.deleteOne({ _id: broadcast._id });
    return { success: true, message: 'Broadcast deleted' };
  },

  /** Render and send exactly one copy to the acting admin. */
  async sendTest(id, actor) {
    const broadcast = await this.getDoc(id);
    const email = cleanEmail(actor.email);
    if (!isEmail(email)) throw badRequest('Your account has no valid email address');

    const recipient = {
      userId: actor.id,
      email,
      businessName: actor.businessName || 'there',
      adHoc: false,
    };

    const result = await this.deliverOne(broadcast, recipient);
    if (!result.delivered) {
      throw badRequest(result.error || 'Test send failed', 502);
    }

    return { success: true, message: `Test sent to ${email}` };
  },

  /** Render + dispatch a single recipient. Never throws. */
  async deliverOne(broadcast, recipient) {
    try {
      const result = await getNotificationService().sendAdminBroadcast({
        email: recipient.email,
        businessName: recipient.businessName,
        subject: interpolate(broadcast.subject, recipient),
        body: interpolate(broadcast.body, recipient),
        preheader: interpolate(broadcast.preheader, recipient),
        ctaLabel: broadcast.ctaLabel,
        ctaUrl: broadcast.ctaUrl,
        // Ad-hoc addresses have no account to flag, so no link is rendered.
        unsubscribeUrl: recipient.userId ? unsubscribeUrl(recipient.userId) : '',
      });

      if (result && result.delivered) return { delivered: true };
      return { delivered: false, error: (result && result.reason) || 'not_delivered' };
    } catch (error) {
      return { delivered: false, error: error.message };
    }
  },

  /**
   * Snapshot the audience and start sending. Returns as soon as the snapshot
   * is durable; delivery continues in the background because a few thousand
   * one-by-one provider calls will outlive the HTTP request.
   */
  async send(id) {
    const broadcast = await this.getDoc(id);

    if (broadcast.status === 'sending') throw badRequest('This broadcast is already sending');
    if (broadcast.status === 'completed') throw badRequest('This broadcast has already been sent');

    const { recipients } = await resolveAudience({
      segments: broadcast.segments,
      segmentDays: broadcast.segmentDays,
      includeEmails: broadcast.includeEmails,
      excludeEmails: broadcast.excludeEmails,
    });

    if (recipients.length === 0) throw badRequest('That audience resolves to nobody');
    if (recipients.length > MAX_RECIPIENTS) {
      throw badRequest(
        `Audience of ${recipients.length} exceeds the ${MAX_RECIPIENTS} recipient limit. Narrow the segments.`
      );
    }

    broadcast.recipients = recipients;
    broadcast.stats = { total: recipients.length, sent: 0, failed: 0, skipped: 0 };
    broadcast.status = 'sending';
    broadcast.startedAt = new Date();
    broadcast.completedAt = null;
    await broadcast.save();

    logger.info('Admin broadcast started:', {
      id: broadcast._id.toString(),
      recipients: recipients.length,
    });

    // Detached on purpose; progress is observable through the detail endpoint.
    this.processQueue(broadcast._id.toString()).catch((error) =>
      logger.error('Broadcast processing failed:', { id: broadcast._id.toString(), error: error.message })
    );

    return {
      success: true,
      id: broadcast._id.toString(),
      queued: recipients.length,
      message: `Sending to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`,
    };
  },

  /**
   * Deliver every `pending` row. Safe to call again after a crash: already
   * sent rows are skipped, so nobody is mailed twice.
   */
  async processQueue(id) {
    const broadcast = await AdminBroadcast.findById(id);
    if (!broadcast) return;

    const pendingIndexes = broadcast.recipients
      .map((recipient, index) => (recipient.status === 'pending' ? index : -1))
      .filter((index) => index >= 0);

    for (let cursor = 0; cursor < pendingIndexes.length; cursor += CHUNK_SIZE) {
      const chunk = pendingIndexes.slice(cursor, cursor + CHUNK_SIZE);

      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(
        chunk.map((index) => this.deliverOne(broadcast, broadcast.recipients[index]))
      );

      chunk.forEach((index, position) => {
        const result = results[position];
        const recipient = broadcast.recipients[index];
        if (result.delivered) {
          recipient.status = 'sent';
          recipient.sentAt = new Date();
          recipient.error = '';
        } else {
          recipient.status = 'failed';
          recipient.error = String(result.error || '').slice(0, 300);
        }
      });

      broadcast.stats.sent = broadcast.recipients.filter((r) => r.status === 'sent').length;
      broadcast.stats.failed = broadcast.recipients.filter((r) => r.status === 'failed').length;
      // eslint-disable-next-line no-await-in-loop
      await broadcast.save();
      // eslint-disable-next-line no-await-in-loop
      await wait(SEND_DELAY_MS);
    }

    broadcast.status = broadcast.stats.sent === 0 && broadcast.stats.failed > 0 ? 'failed' : 'completed';
    broadcast.completedAt = new Date();
    await broadcast.save();

    logger.info('Admin broadcast finished:', {
      id: broadcast._id.toString(),
      sent: broadcast.stats.sent,
      failed: broadcast.stats.failed,
    });
  },

  /** Re-queue only the failures, then run the same loop. */
  async retryFailed(id) {
    const broadcast = await this.getDoc(id);
    if (broadcast.status === 'sending') throw badRequest('This broadcast is still sending');

    const failed = broadcast.recipients.filter((recipient) => recipient.status === 'failed');
    if (failed.length === 0) throw badRequest('There are no failed recipients to retry');

    failed.forEach((recipient) => {
      recipient.status = 'pending';
      recipient.error = '';
    });
    broadcast.status = 'sending';
    await broadcast.save();

    this.processQueue(broadcast._id.toString()).catch((error) =>
      logger.error('Broadcast retry failed:', { id: broadcast._id.toString(), error: error.message })
    );

    return { success: true, queued: failed.length, message: `Retrying ${failed.length} recipient(s).` };
  },

  /**
   * Honour a one-click unsubscribe. The response is intentionally generic so
   * the endpoint cannot be used to probe which addresses are registered.
   */
  async unsubscribe(token) {
    const userId = verifyUnsubscribeToken(token);
    const generic = {
      success: true,
      message: 'You have been unsubscribed from Chatstand announcements.',
    };

    if (!userId || !mongoose.isValidObjectId(userId)) return generic;

    const user = await User.findByIdAndUpdate(userId, { $set: { marketingOptOut: true } }, { new: true });
    if (user) {
      logger.info('Seller opted out of broadcasts:', { id: userId });
      return { ...generic, email: user.email };
    }
    return generic;
  },

  /** Let an admin re-enable a seller, or a seller resubscribe from the page. */
  async resubscribe(token) {
    const userId = verifyUnsubscribeToken(token);
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return { success: true, message: 'Preference updated.' };
    }
    await User.findByIdAndUpdate(userId, { $set: { marketingOptOut: false } });
    return { success: true, message: 'You will receive Chatstand announcements again.' };
  },
};

module.exports = adminBroadcastService;
module.exports.unsubscribeUrl = unsubscribeUrl;
module.exports.verifyUnsubscribeToken = verifyUnsubscribeToken;
