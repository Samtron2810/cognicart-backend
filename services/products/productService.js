/**
 * Product Catalog Service
 * Multi-tenant catalog management with variants, discounts, search, and stock tracking
 */

const Product = require('../../models/Product');
const { isDbConnected } = require('../../config/db');
const { sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryProducts = new Map();

function normalizeStock(payload) {
  if (payload.variants && Array.isArray(payload.variants) && payload.variants.length > 0) {
    return payload.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  }
  return Number(payload.stock) || 0;
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

    if (isDbConnected()) {
      if (search) {
        const q = sanitize(search, 100);
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
    }

    // In-memory fallback
    let items = Array.from(memoryProducts.values());

    if (isPublic) {
      items = items.filter((p) => p.isActive);
      if (sellerId) items = items.filter((p) => p.sellerId === sellerId);
    } else {
      if (sellerId) items = items.filter((p) => p.sellerId === sellerId);
      if (isActive !== undefined) {
        const activeBool = isActive === true || isActive === 'true';
        items = items.filter((p) => p.isActive === activeBool);
      }
    }

    if (category) {
      items = items.filter((p) => p.category === category);
    }

    if (search) {
      const q = sanitize(search, 100).toLowerCase();
      const words = q.split(/\s+/).filter((w) => w.length > 2 && !['the', 'for', 'and', 'with', 'item'].includes(w));
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          (words.length > 0 && words.every((w) => p.name.toLowerCase().includes(w) || p.description.toLowerCase().includes(w))) ||
          (p.variants || []).some(
            (v) =>
              (v.sku && v.sku.toLowerCase().includes(q)) ||
              (v.size && v.size.toLowerCase().includes(q)) ||
              (v.color && v.color.toLowerCase().includes(q))
          )
      );
    }

    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

    if (isDbConnected()) {
      const product = await Product.findById(id);
      if (!product) {
        const err = new Error('Product not found');
        err.statusCode = 404;
        throw err;
      }

      if (isPublic) {
        if (!product.isActive) {
          const err = new Error('Product is inactive');
          err.statusCode = 404;
          throw err;
        }
        return product.toJSON();
      }

      // Enforce tenant isolation for private access
      if (sellerId && product.sellerId !== sellerId) {
        logger.warn('Cross-tenant product access attempt blocked:', { id, sellerId, productOwner: product.sellerId });
        const err = new Error('Product not found or access denied');
        err.statusCode = 404;
        throw err;
      }

      return product.toJSON();
    }

    // In-memory fallback
    const product = memoryProducts.get(id);
    if (!product) {
      const err = new Error('Product not found');
      err.statusCode = 404;
      throw err;
    }

    if (isPublic) {
      if (!product.isActive) {
        const err = new Error('Product is inactive');
        err.statusCode = 404;
        throw err;
      }
      return product;
    }

    if (sellerId && product.sellerId !== sellerId) {
      logger.warn('Cross-tenant product access blocked (Memory):', { id, sellerId, productOwner: product.sellerId });
      const err = new Error('Product not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    return product;
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

    const price = Number(payload.price);
    if (isNaN(price) || price < 0) {
      const err = new Error('Valid price is required (cannot be negative)');
      err.statusCode = 400;
      throw err;
    }

    const stock = normalizeStock(payload);

    const productData = {
      sellerId,
      name,
      description: sanitize(payload.description || '', 3000),
      price,
      currency: payload.currency || 'NGN',
      stock,
      category: sanitize(payload.category || 'Other', 50),
      images: Array.isArray(payload.images) ? payload.images : [],
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      discount: payload.discount || { active: false, type: 'percentage', value: 0 },
      variants: Array.isArray(payload.variants) ? payload.variants : [],
    };

    if (isDbConnected()) {
      const product = await Product.create(productData);
      logger.info('Product created (DB):', { id: product._id.toString(), sellerId, name: product.name });
      return product.toJSON();
    }

    // In-memory fallback
    const id = 'prod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const memProduct = {
      id,
      _id: id,
      ...productData,
      createdAt: now,
      updatedAt: now,
    };
    memoryProducts.set(id, memProduct);
    logger.info('Product created (Memory):', { id, sellerId, name: memProduct.name });
    return memProduct;
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
    if (payload.isActive !== undefined) updates.isActive = payload.isActive;
    if (payload.discount !== undefined) updates.discount = payload.discount;
    if (payload.variants !== undefined && Array.isArray(payload.variants)) {
      updates.variants = payload.variants;
      updates.stock = normalizeStock({ ...payload, variants: payload.variants });
    } else if (payload.stock !== undefined) {
      updates.stock = Number(payload.stock);
    }

    if (isDbConnected()) {
      const product = await Product.findOneAndUpdate(
        { _id: id, sellerId },
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!product) {
        logger.warn('Product update blocked: not found or cross-tenant', { id, sellerId });
        const err = new Error('Product not found or access denied');
        err.statusCode = 404;
        throw err;
      }

      logger.info('Product updated (DB):', { id, sellerId });
      return product.toJSON();
    }

    // In-memory fallback
    const current = memoryProducts.get(id);
    if (!current || current.sellerId !== sellerId) {
      logger.warn('Product update blocked (Memory):', { id, sellerId });
      const err = new Error('Product not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    const updated = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    memoryProducts.set(id, updated);
    logger.info('Product updated (Memory):', { id, sellerId });
    return updated;
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

    if (isDbConnected()) {
      const result = await Product.findOneAndDelete({ _id: id, sellerId });
      if (!result) {
        const err = new Error('Product not found or access denied');
        err.statusCode = 404;
        throw err;
      }
      logger.info('Product deleted (DB):', { id, sellerId });
      return { success: true, message: 'Product deleted successfully' };
    }

    const current = memoryProducts.get(id);
    if (!current || current.sellerId !== sellerId) {
      const err = new Error('Product not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    memoryProducts.delete(id);
    logger.info('Product deleted (Memory):', { id, sellerId });
    return { success: true, message: 'Product deleted successfully' };
  },

  /**
   * Direct stock adjustment for orders
   */
  async adjustStock(id, sellerId, quantityToDeduct, variantId) {
    if (isDbConnected()) {
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
    }

    const current = memoryProducts.get(id);
    if (!current || current.sellerId !== sellerId) throw new Error(`Product not found: ${id}`);

    if (variantId && current.variants && current.variants.length > 0) {
      const v = current.variants.find((x) => x.id === variantId);
      if (!v) throw new Error(`Variant ${variantId} not found`);
      if (v.stock < quantityToDeduct) throw new Error(`Insufficient stock for ${current.name}`);
      v.stock -= quantityToDeduct;
      current.stock = current.variants.reduce((s, item) => s + item.stock, 0);
    } else {
      if (current.stock < quantityToDeduct) throw new Error(`Insufficient stock for ${current.name}`);
      current.stock -= quantityToDeduct;
    }
    current.updatedAt = new Date().toISOString();
    memoryProducts.set(id, current);
    return current;
  },

  getMemoryStore() {
    return memoryProducts;
  },
};

module.exports = productService;
