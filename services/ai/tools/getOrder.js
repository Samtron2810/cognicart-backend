/** Buyer-scoped order tracking tool. */

const orderService = require('../../orders/orderService');

const definition = {
  type: 'function',
  function: {
    name: 'getOrder',
    description:
      'Fetch status and payment details for an order owned by the buyer in this conversation. Accepts an ObjectId or reference such as #00012.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'Order ObjectId or human reference such as #00012',
        },
      },
      required: ['orderId'],
    },
  },
};

async function execute(sellerId, args, context = {}) {
  if (!args || !args.orderId) throw new Error('Order reference is required');
  const order = await orderService.resolveForCounterparty(sellerId, args.orderId, context);
  return {
    id: order.id,
    reference: order.reference,
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    paymentReference: order.paymentReference || '',
    items: order.items,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    deliveryAddress: order.deliveryAddress,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt || null,
  };
}

module.exports = { definition, execute };
