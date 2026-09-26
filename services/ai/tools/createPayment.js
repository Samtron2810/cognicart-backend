/**
 * AI Tool: createPayment
 */

const orderService = require('../../orders/orderService');
const paymentService = require('../../payments/paymentService');

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

async function execute(sellerId, args) {
  if (!args || !args.orderId) throw new Error('orderId is required');

  const order = await orderService.getById(args.orderId, sellerId);
  if (!order) throw new Error(`Order not found: ${args.orderId}`);

  if (order.paymentStatus === 'Paid') {
    return {
      alreadyPaid: true,
      reference: order.paymentReference,
      message: 'This order has already been paid for.',
    };
  }

  const email = args.email || `${order.customerPhone.replace(/[^0-9]/g, '')}@wabac.ng`;

  const { reference, authorization_url, transaction } = await paymentService.initialize({
    orderId: order.id,
    sellerId,
    amount: order.total,
    email,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
  });

  return {
    reference,
    authorization_url,
    amount: order.total,
    currency: 'NGN',
    transaction,
  };
}

module.exports = {
  definition,
  execute,
};
