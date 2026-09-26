/**
 * AI Tool: checkStock
 */

const productService = require('../../products/productService');
const { getEffectivePrice } = require('../../../models/Product');

const definition = {
  type: 'function',
  function: {
    name: 'checkStock',
    description: 'Verify current stock availability and price for a product or specific variant.',
    parameters: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'The unique ID of the product',
        },
        variantId: {
          type: 'string',
          description: 'Optional variant ID (for specific size/color options)',
        },
      },
      required: ['productId'],
    },
  },
};

async function execute(sellerId, args) {
  if (!args || !args.productId) {
    throw new Error('productId is required');
  }

  const product = await productService.getById(args.productId, sellerId, true);
  let availableStock = product.stock;
  let variant = null;

  if (args.variantId && product.variants && product.variants.length > 0) {
    variant = product.variants.find((v) => v.id === args.variantId);
    if (!variant) throw new Error(`Variant ${args.variantId} not found`);
    availableStock = variant.stock;
  }

  const effectivePrice = getEffectivePrice(product, variant);

  return {
    productId: product.id,
    name: product.name,
    available: availableStock > 0,
    stock: availableStock,
    price: effectivePrice,
    originalPrice: variant && variant.price ? variant.price : product.price,
    hasDiscount: effectivePrice < (variant && variant.price ? variant.price : product.price),
    variants: (product.variants || []).map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      stock: v.stock,
      price: v.price || product.price,
    })),
  };
}

module.exports = {
  definition,
  execute,
};
