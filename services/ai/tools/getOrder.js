/**
 * AI Tool: getOrder
 */

const orderService = require('../../orders/orderService');
const { requireOrderAccess } = require('../toolGuards');

const definition = {
  type: 'function',
  function: {
    name: 'getOrder',
    description:
      "Fetch real-time order status, items, tracking, and payment verification state by order ID. Only returns orders belonging to the customer you are currently chatting with.",
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

async function execute(sellerId, args, context = {}) {
  if (!args || !args.orderId) throw new Error('orderId is required');

  const order = await orderService.getById(args.orderId, sellerId);

  // Tenant scope alone is not enough: an order also has to belong to the
  // person in this conversation, or its address would leak to a stranger.
  requireOrderAccess(order, context, args.orderId);

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
