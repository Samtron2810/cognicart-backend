/**
 * Multi-Seller Group Payment Service
 *
 * One Paystack charge for a basket spanning several stores, fanned out into
 * one Payment record per seller once the provider confirms it.
 *
 * Why a parallel path instead of extending paymentService.initialize():
 * that function is the single-seller flow the Telegram bot and every existing
 * storefront order already depend on, with its own idempotency, reuse and
 * reconciliation logic. Money code that works should not be refactored to
 * add a feature next to it. This file sits alongside it and reuses the same
 * Paystack client, the same fee config and the same Payment model, so
 * payouts, revenue reporting and the seller dashboard keep working unchanged.
 *
 * The two things that must be true, and are tested:
 *   1. The buyer is charged the group's grand total, verified against
 *      Paystack — never against a number the browser sent.
 *   2. Settling is idempotent. A webhook, a callback and a manual verify can
 *      all land at once, or twice, and each seller is still credited exactly
 *      once. That guarantee is a unique index, not a flag we hope holds.
 */

const crypto = require('crypto');
const Payment = require('../../models/Payment');
const Order = require('../../models/Order');
const OrderGroup = require('../../models/OrderGroup');
const orderService = require('../orders/orderService');
const orderGroupService = require('../orders/orderGroupService');
const paymentService = require('./paymentService');
const paystackClient = require('./paystackClient');
const logger = require('../../utils/logger');

/**
 * Group references are prefixed so every entry point — webhook, callback,
 * manual verify — can tell a group charge from a single-seller one by
 * looking at the string, with no database round trip and no ambiguity.
 */
const GROUP_REFERENCE_PREFIX = 'GRP_';

function isGroupReference(reference) {
  return typeof reference === 'string' && reference.startsWith(GROUP_REFERENCE_PREFIX);
}

function genGroupReference() {
  return `${GROUP_REFERENCE_PREFIX}${Date.now().toString(36).toUpperCase()}_${crypto
    .randomBytes(8)
    .toString('hex')
    .toUpperCase()}`;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function calculatePaystackFee(amount) {
  return Math.min(Math.round(amount * 0.015), 2000);
}

function checkoutCallbackUrl() {
  const apiOrigin = String(process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(apiOrigin)) {
    throw httpError('API_PUBLIC_URL must be configured for secure payment callbacks', 503);
  }
  return `${apiOrigin}/api/payments/callback`;
}

const groupPaymentService = {
  GROUP_REFERENCE_PREFIX,
  isGroupReference,

  /**
   * Start one Paystack transaction covering every sub-order in the group.
   */
  async initialize(groupId, { email } = {}) {
    const group = await orderGroupService.getById(groupId);

    if (group.paymentStatus === 'Paid') throw httpError('This order has already been paid', 409);

    const amount = Number(group.grandTotal);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError('Order group has an invalid total');

    const buyerEmail = String(email || group.customerEmail || '').trim().toLowerCase();
    if (!isEmail(buyerEmail)) throw httpError('A valid customer email is required for Paystack checkout');

    // Reuse a live checkout link rather than issuing a second payable URL
    // for the same basket.
    if (group.paymentReference && group.authorizationUrl) {
      try {
        const provider = await paystackClient.verifyTransaction(group.paymentReference);
        const status = String(provider.status || '').toLowerCase();
        if (status === 'success') {
          const settled = await this.settle(group, provider);
          return { reference: settled.paymentReference, authorization_url: '', alreadyPaid: true, group: settled.toJSON() };
        }
        if (!['failed', 'abandoned', 'reversed'].includes(status)) {
          return { reference: group.paymentReference, authorization_url: group.authorizationUrl, reused: true };
        }
      } catch (error) {
        logger.warn('Could not refresh pending group transaction; issuing a new one', {
          reference: group.paymentReference,
          error: error.message,
        });
      }
    }

    const reference = genGroupReference();
    const provider = await paystackClient.initializeTransaction({
      email: buyerEmail,
      amount,
      reference,
      callback_url: checkoutCallbackUrl(),
      metadata: {
        orderGroupId: group._id.toString(),
        groupReference: `ORD-${group.groupNumber}`,
        sellerCount: group.sellerIds.length,
      },
    });

    if (!provider || !provider.authorization_url) {
      throw httpError('Paystack did not return a checkout URL', 502);
    }

    group.paymentReference = reference;
    group.authorizationUrl = provider.authorization_url;
    group.paymentStatus = 'Pending';
    await group.save();

    logger.info('Group payment initialized:', { reference, groupId: group._id.toString(), amount });
    return { reference, authorization_url: provider.authorization_url };
  },

  /**
   * Verify a group reference with Paystack and settle it.
   * Safe to call repeatedly — that is the point.
   */
  async verify(reference) {
    if (!reference) throw httpError('Payment reference is required');

    const group = await OrderGroup.findOne({ paymentReference: reference });
    if (!group) throw httpError('Transaction not found', 404);

    const provider = await paystackClient.verifyTransaction(reference);
    const status = String(provider.status || '').toLowerCase();

    if (status !== 'success') {
      if (['failed', 'abandoned', 'reversed'].includes(status) && group.paymentStatus !== 'Paid') {
        group.paymentStatus = 'Failed';
        await group.save();
      }
      throw httpError(`Payment has not succeeded (provider status: ${status || 'unknown'})`, 409);
    }

    return this.settle(group, provider);
  },

  /**
   * Fan a confirmed group charge out to its sub-orders.
   *
   * Each seller gets their own Payment row, with its own unique reference
   * derived from the group reference plus the sub-order label. That uniqueness
   * is enforced by the index on `Payment.reference`, so a duplicate attempt
   * fails at the database rather than quietly crediting a seller twice. A
   * concurrent caller is also excluded by a short claim on the group.
   */
  async settle(group, provider) {
    // The amount is read back from Paystack, never from the browser. A
    // mismatch means the charge does not cover the basket, so nothing is
    // settled and it is raised loudly.
    const paidAmount = Number(provider.amount) / 100;
    if (Math.abs(paidAmount - Number(group.grandTotal)) > 0.5) {
      logger.error('Group payment amount mismatch; refusing to settle', {
        reference: group.paymentReference,
        paid: paidAmount,
        expected: group.grandTotal,
      });
      throw httpError('Paid amount does not match the order total', 409);
    }

    if (group.settledAt && group.paymentStatus === 'Paid') return group;

    // Claim the group for 60s so a webhook and a callback arriving together
    // do not both run the fan-out.
    const now = new Date();
    const claimCutoff = new Date(now.getTime() - 60 * 1000);
    const claimed = await OrderGroup.findOneAndUpdate(
      {
        _id: group._id,
        $or: [{ settlementClaimedAt: null }, { settlementClaimedAt: { $lte: claimCutoff } }],
      },
      { $set: { settlementClaimedAt: now } },
      { new: true }
    );

    if (!claimed) {
      // Someone else is mid-settlement. Return what we have; the caller's
      // next read, or a webhook retry, will see the finished state.
      logger.info('Group settlement already in progress', { reference: group.paymentReference });
      return OrderGroup.findById(group._id);
    }

    const fee = await paymentService.getFeeConfig();
    let settledCount = 0;

    for (const line of claimed.orders) {
      if (line.settledAt) {
        settledCount += 1;
        continue;
      }

      const subReference = `${claimed.paymentReference}-${line.label}`;
      const lineAmount = Number(line.total) || 0;
      const platformFee = Math.round(lineAmount * (fee.percentage / 100) + fee.fixed);
      const paystackFee = calculatePaystackFee(lineAmount);
      const sellerAmount = Math.max(0, lineAmount - platformFee - paystackFee);

      try {
        await Payment.create({
          sellerId: line.sellerId,
          orderId: line.orderId,
          amount: lineAmount,
          subtotal: line.subtotal,
          deliveryFee: line.deliveryFee,
          platformFee,
          sellerAmount,
          paystackFee,
          reference: subReference,
          email: claimed.customerEmail,
          status: 'success',
          providerStatus: 'success',
          providerTransactionId: provider.id ? String(provider.id) : '',
          verifiedAt: now,
          lastVerifiedAt: now,
        });
      } catch (error) {
        if (error && error.code === 11000) {
          // Already credited by a previous run. Exactly the outcome we want.
          logger.info('Sub-order payment already recorded', { reference: subReference });
        } else {
          logger.error('Could not record sub-order payment', {
            reference: subReference,
            error: error.message,
          });
          continue; // leave this line unsettled; a retry will pick it up
        }
      }

      try {
        await orderService.updatePaymentStatus(line.orderId, line.sellerId, 'Paid', subReference);
      } catch (error) {
        logger.error('Could not mark sub-order paid', { orderId: line.orderId, error: error.message });
        continue;
      }

      await OrderGroup.updateOne(
        { _id: claimed._id, 'orders.orderId': line.orderId },
        { $set: { 'orders.$.settledAt': now, 'orders.$.paymentReference': subReference } }
      );
      settledCount += 1;
    }

    const allSettled = settledCount === claimed.orders.length;

    const finished = await OrderGroup.findByIdAndUpdate(
      claimed._id,
      {
        $set: {
          // "Partially Settled" is a real, visible state rather than a lie in
          // either direction: the buyer has paid, but not every seller has
          // been credited yet, and that needs to be findable.
          paymentStatus: allSettled ? 'Paid' : 'Partially Settled',
          paidAt: claimed.paidAt || now,
          settledAt: allSettled ? now : null,
          settlementClaimedAt: null,
        },
      },
      { new: true }
    );

    logger.info('Group payment settled:', {
      reference: claimed.paymentReference,
      settled: settledCount,
      of: claimed.orders.length,
    });

    if (!allSettled) {
      logger.error('Group payment only partially settled; needs review', {
        reference: claimed.paymentReference,
        settled: settledCount,
        of: claimed.orders.length,
      });
    }

    return finished;
  },

  /** Buyer-facing status lookup by group reference. */
  async getByReference(reference) {
    const group = await OrderGroup.findOne({ paymentReference: reference });
    if (!group) return null;
    const orders = await Order.find({ parentOrderId: group._id.toString() })
      .select('sellerId orderStatus paymentStatus groupLabel')
      .lean();
    return { ...group.toJSON(), subOrders: orders };
  },
};

module.exports = groupPaymentService;
