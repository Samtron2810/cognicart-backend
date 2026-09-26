/**
 * AI Tool: calculateOrderTotal
 */

const productService = require('../../products/productService');
const businessService = require('../../sellers/businessService');
const { getEffectivePrice } = require('../../../models/Product');

const definition = {
  type: 'function',
  function: {
    name: 'calculateOrderTotal',
    description: 'Calculate subtotal, delivery fee, and grand total for an order using authoritative prices.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'List of order items with productId, quantity, and optional variantId',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string' },
              quantity: { type: 'number' },
              variantId: { type: 'string' },
            },
            required: ['productId', 'quantity'],
          },
        },
        deliveryFee: {
          type: 'number',
          description: 'Optional manual delivery fee override',
        },
      },
      required: ['items'],
    },
  },
};

async function execute(sellerId, args) {
  if (!args || !Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('Items array is required');
  }

  let subtotal = 0;
  const itemSummaries = [];

  for (const item of args.items) {
    const product = await productService.getById(item.productId, sellerId, true);
    let variant = null;

    if (item.variantId && product.variants && product.variants.length > 0) {
      variant = product.variants.find((v) => v.id === item.variantId);
    }

    const unitPrice = getEffectivePrice(product, variant);
    const lineTotal = unitPrice * item.quantity;
    subtotal += lineTotal;

    itemSummaries.push({
      productId: product.id,
      name: product.name,
      variant: variant ? `${variant.size || ''} ${variant.color || ''}`.trim() : null,
      unitPrice,
      quantity: item.quantity,
      lineTotal,
    });
  }

  let deliveryFee = 0;
  if (args.deliveryFee !== undefined && !isNaN(Number(args.deliveryFee))) {
    deliveryFee = Number(args.deliveryFee);
  } else {
    const biz = await businessService.getBySellerId(sellerId);
    if (biz && biz.freeDeliveryThreshold && subtotal >= biz.freeDeliveryThreshold) {
      deliveryFee = 0;
    } else {
      deliveryFee = biz && biz.deliveryFee !== undefined ? biz.deliveryFee : 1500;
    }
  }

  return {
    items: itemSummaries,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
  };
}

module.exports = {
  definition,
  execute,
};
