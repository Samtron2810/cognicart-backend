/**
 * AI Tool: getOrder
 */

const orderService = require('../../orders/orderService');

const definition = {
  type: 'function',
  function: {
    name: 'getOrder',
    description: 'Fetch real-time order status, items, tracking, and payment verification state by order ID.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique order ID (e.g. ord_...)',
        },
      },
      required: ['orderId'],
    },
  },
};

async function execute(sellerId, args) {
  if (!args || !args.orderId) throw new Error('orderId is required');
  const order = await orderService.getById(args.orderId, sellerId);
  return {
    id: order.id,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    items: order.items,
    total: order.total,
    deliveryAddress: order.deliveryAddress,
    createdAt: order.createdAt,
  };
}

module.exports = {
  definition,
  execute,
};
