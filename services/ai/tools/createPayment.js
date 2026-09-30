/**
 * AI Tool: createPayment
 */

const orderService = require('../../orders/orderService');
const paymentService = require('../../payments/paymentService');
const { requireOrderAccess } = require('../toolGuards');
const { isEmail } = require('../../../utils/validators');

const definition = {
  type: 'function',
  function: {
    name: 'createPayment',
    description: 'Generate a Paystack payment reference and checkout link for an order so the customer can pay via card or bank transfer.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique ID of the order to pay for',
        },
        email: {
          type: 'string',
          description: 'Customer email address for payment receipt',
        },
      },
      required: ['orderId'],
    },
  },
};

async function execute(sellerId, args, context = {}) {
  if (!args || !args.orderId) throw new Error('orderId is required');

  const order = await orderService.getById(args.orderId, sellerId);
  if (!order) throw new Error(`Order not found: ${args.orderId}`);

  // Never generate a payment link (or expose an order total) for someone else
  requireOrderAccess(order, context, args.orderId);

  if (order.paymentStatus === 'Paid') {
    return {
      alreadyPaid: true,
      reference: order.paymentReference,
      message: 'This order has already been paid for.',
    };
  }

  if (order.orderStatus === 'Cancelled') throw new Error('Cancelled orders cannot be paid');

  const email = String(args.email || order.customerEmail || context.customerEmail || '').trim().toLowerCase();
  if (!isEmail(email)) {
    const error = new Error('A valid email address is required to open Paystack checkout.');
    error.code = 'PAYMENT_EMAIL_REQUIRED';
    throw error;
  }

  const { reference, authorization_url, transaction, reused, alreadyPaid } = await paymentService.initialize({
    orderId: order.id,
    sellerId,
    amount: order.total,
    email,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
  });

  if (alreadyPaid) {
    return {
      alreadyPaid: true,
      reference,
      message: 'Paystack has confirmed payment for this order.',
    };
  }

  return {
    reference,
    authorization_url,
    amount: order.total,
    currency: 'NGN',
    transaction,
    reused: Boolean(reused),
  };
}

module.exports = {
  definition,
  execute,
};
