/**
 * AI Tool: getProduct
 */

const productService = require('../../products/productService');

const definition = {
  type: 'function',
  function: {
    name: 'getProduct',
    description: 'Fetch detailed product specification, active discounts, variants, and stock by product ID.',
    parameters: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'The unique ID of the product',
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
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    stock: product.stock,
    category: product.category,
    images: product.images,
    discount: product.discount,
    variants: product.variants,
  };
}

module.exports = {
  definition,
  execute,
};
