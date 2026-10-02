/**
 * Product Catalog Service
 * Multi-tenant catalog management with variants, discounts, search, and stock tracking
 */

const mongoose = require('mongoose');
const Product = require('../../models/Product');
const { sanitize, escapeRegex } = require('../../utils/validators');
const logger = require('../../utils/logger');
const { deleteFromCloudinary } = require('../../utils/cloudinary');

/**
 * Base64 data URIs are no longer accepted: the browser uploads directly to
 * Cloudinary and only the resulting URL is stored. This keeps a stale client
 * from re-introducing multi-megabyte product documents.
 */
function rejectDataUris(images) {
  if (!Array.isArray(images)) return;
  const offender = images.find(
    (value) => typeof value === 'string' && value.trim().toLowerCase().startsWith('data:')
  );
  if (offender) {
    const err = new Error(
      'Inline base64 images are not accepted. Upload each file to Cloudinary and send its URL.'
    );
    err.statusCode = 400;
    throw err;
  }
}

/** Destroy Cloudinary assets that are no longer referenced. Never throws. */
function destroyAssets(publicIds, context) {
  (publicIds || [])
    .filter(Boolean)
    .forEach((publicId) =>
      deleteFromCloudinary(publicId).catch((error) =>
        logger.warn('Could not delete product image asset:', { ...context, publicId, error: error.message })
      )
    );
}

function normalizeStock(payload) {
  if (payload.variants && Array.isArray(payload.variants) && payload.variants.length > 0) {
    return payload.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  }
  return Number(payload.stock) || 0;
}

function notFound(message = 'Product not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

const productService = {
  /**
   * List products with multi-tenant filtering, search, and public catalog support
   */
  async list({ sellerId, search, category, isActive, isPublic } = {}) {
    const filter = {};

    if (isPublic) {
      filter.isActive = true;
      if (sellerId) filter.sellerId = sellerId;
    } else {
      if (sellerId) filter.sellerId = sellerId;
      if (isActive !== undefined) filter.isActive = isActive === true || isActive === 'true';
    }

    if (category) {
      filter.category = category;
    }

    if (search) {
      const q = escapeRegex(sanitize(search, 100));
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { 'variants.sku': { $regex: q, $options: 'i' } },
        { 'variants.size': { $regex: q, $options: 'i' } },
        { 'variants.color': { $regex: q, $options: 'i' } },
      ];
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    return products.map((p) => p.toJSON());
  },

  /**
   * Get product by ID with strict tenant isolation check
   */
  async getById(id, sellerId, isPublic = false) {
    if (!id) {
      const err = new Error('Product ID is required');
      err.statusCode = 400;
      throw err;
    }

    if (!mongoose.isValidObjectId(id)) {
      throw notFound();
    }

    const product = await Product.findById(id);
    if (!product) {
      throw notFound();
    }

    if (isPublic) {
      if (!product.isActive) {
        throw notFound('Product is inactive');
      }
      return product.toJSON();
    }

    // Enforce tenant isolation for private access
    if (sellerId && product.sellerId !== sellerId) {
      logger.warn('Cross-tenant product access attempt blocked:', { id, sellerId, productOwner: product.sellerId });
      throw notFound('Product not found or access denied');
    }

    return product.toJSON();
  },

  /**
   * Create a new product for a seller
   */
  async create(sellerId, payload) {
    if (!sellerId) {
      const err = new Error('Seller ID is required');
      err.statusCode = 400;
      throw err;
    }

    const name = sanitize(payload.name, 120);
    if (!name || name.length < 2) {
      const err = new Error('Product name must be at least 2 characters');
      err.statusCode = 400;
      throw err;
    }

    rejectDataUris(payload.images);

    const price = Number(payload.price);
    if (isNaN(price) || price < 0) {
      const err = new Error('Valid price is required (cannot be negative)');
      err.statusCode = 400;
      throw err;
    }

    const productData = {
      sellerId,
      name,
      description: sanitize(payload.description || '', 3000),
      price,
      currency: payload.currency || 'NGN',
      stock: normalizeStock(payload),
      category: sanitize(payload.category || 'Other', 50),
      images: Array.isArray(payload.images) ? payload.images : [],
      imagePublicIds: Array.isArray(payload.imagePublicIds) ? payload.imagePublicIds : [],
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      discount: payload.discount || { active: false, type: 'percentage', value: 0 },
      variants: Array.isArray(payload.variants) ? payload.variants : [],
    };

    const product = await Product.create(productData);
    logger.info('Product created:', { id: product._id.toString(), sellerId, name: product.name });
    return product.toJSON();
  },

  /**
   * Update a product (enforcing tenant isolation)
   */
  async update(id, sellerId, payload) {
    if (!id || !sellerId) {
      const err = new Error('Product ID and seller context are required');
      err.statusCode = 400;
      throw err;
    }

    rejectDataUris(payload.images);

    const updates = {};
    if (payload.name !== undefined) updates.name = sanitize(payload.name, 120);
    if (payload.description !== undefined) updates.description = sanitize(payload.description, 3000);
    if (payload.price !== undefined) {
      const p = Number(payload.price);
      if (isNaN(p) || p < 0) {
        const err = new Error('Invalid price');
        err.statusCode = 400;
        throw err;
      }
      updates.price = p;
    }
    if (payload.category !== undefined) updates.category = sanitize(payload.category, 50);
    if (payload.images !== undefined && Array.isArray(payload.images)) updates.images = payload.images;
    if (payload.imagePublicIds !== undefined && Array.isArray(payload.imagePublicIds)) {
      updates.imagePublicIds = payload.imagePublicIds;
    }
    if (payload.isActive !== undefined) updates.isActive = payload.isActive;
    if (payload.discount !== undefined) updates.discount = payload.discount;
    if (payload.variants !== undefined && Array.isArray(payload.variants)) {
      updates.variants = payload.variants;
      updates.stock = normalizeStock({ ...payload, variants: payload.variants });
    } else if (payload.stock !== undefined) {
      updates.stock = Number(payload.stock);
    }

    if (!mongoose.isValidObjectId(id)) {
      throw notFound('Product not found or access denied');
    }

    // Work out which assets the incoming image set drops, before overwriting.
    let orphanedImageIds = [];
    if (updates.imagePublicIds !== undefined) {
      const current = await Product.findOne({ _id: id, sellerId }).select('imagePublicIds').lean();
      const kept = new Set(updates.imagePublicIds.filter(Boolean));
      orphanedImageIds = ((current && current.imagePublicIds) || []).filter((pid) => pid && !kept.has(pid));
    }

    const product = await Product.findOneAndUpdate(
      { _id: id, sellerId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!product) {
      logger.warn('Product update blocked: not found or cross-tenant', { id, sellerId });
      throw notFound('Product not found or access denied');
    }

    logger.info('Product updated:', { id, sellerId });
    destroyAssets(orphanedImageIds, { id, sellerId });

    return product.toJSON();
  },

  /**
   * Delete a product (enforcing tenant isolation)
   */
  async remove(id, sellerId) {
    if (!id || !sellerId) {
      const err = new Error('Product ID and seller context are required');
      err.statusCode = 400;
      throw err;
    }

    if (!mongoose.isValidObjectId(id)) {
      throw notFound('Product not found or access denied');
    }

    const result = await Product.findOneAndDelete({ _id: id, sellerId });
    if (!result) {
      throw notFound('Product not found or access denied');
    }

    // A deleted product's images are unreachable; release the storage.
    destroyAssets(result.imagePublicIds, { id, sellerId });

    logger.info('Product deleted:', { id, sellerId });
    return { success: true, message: 'Product deleted successfully' };
  },

  /**
   * Restore reserved stock exactly once for a durable operation key. The stock
   * increment and idempotency marker live in one atomic Product update, so a
   * cancellation retry can safely continue after a process crash.
   */
  async restoreStockOnce(id, sellerId, quantity, variantId, operationKey) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`Product not found: ${id}`);
    const amount = Number(quantity);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Restoration quantity must be positive');
    if (!operationKey) throw new Error('Inventory restoration operation key is required');

    const filter = {
      _id: id,
      sellerId,
      stockAdjustmentKeys: { $ne: operationKey },
    };
    const increment = { stock: amount };
    const options = { new: true };
    if (variantId) {
      filter.variants = { $elemMatch: { id: variantId } };
      increment['variants.$[variant].stock'] = amount;
      options.arrayFilters = [{ 'variant.id': variantId }];
    }

    const product = await Product.findOneAndUpdate(
      filter,
      {
        $inc: increment,
        $addToSet: { stockAdjustmentKeys: operationKey },
      },
      options
    );
    if (product) return { product: product.toJSON(), applied: true };

    const current = await Product.findOne({ _id: id, sellerId }).select('+stockAdjustmentKeys');
    if (!current) throw new Error(`Product not found: ${id}`);
    if ((current.stockAdjustmentKeys || []).includes(operationKey)) {
      return { product: current.toJSON(), applied: false };
    }
    if (variantId && !(current.variants || []).some((variant) => variant.id === variantId)) {
      throw new Error(`Variant ${variantId} not found for product ${current.name}`);
    }
    throw new Error(`Could not restore stock for ${current.name}`);
  },

  /**
   * Direct stock adjustment for orders
   */
  async adjustStock(id, sellerId, quantityToDeduct, variantId) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`Product not found: ${id}`);

    const product = await Product.findOne({ _id: id, sellerId });
    if (!product) throw new Error(`Product not found: ${id}`);

    if (variantId && product.variants && product.variants.length > 0) {
      const v = product.variants.find((x) => x.id === variantId);
      if (!v) throw new Error(`Variant ${variantId} not found for product ${product.name}`);
      if (v.stock < quantityToDeduct) throw new Error(`Insufficient stock for ${product.name} (${v.size || ''} ${v.color || ''})`);
      v.stock -= quantityToDeduct;
      product.stock = product.variants.reduce((s, item) => s + item.stock, 0);
    } else {
      if (product.stock < quantityToDeduct) throw new Error(`Insufficient stock for ${product.name}`);
      product.stock -= quantityToDeduct;
    }

    await product.save();
    return product.toJSON();
  },
};

module.exports = productService;
