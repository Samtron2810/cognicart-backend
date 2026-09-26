/**
 * Public Storefront & Discoverability Service
 * Powers public catalog browsing, category aggregations, slug routing, OpenGraph/Twitter cards, Schema.org JSON-LD, and XML sitemaps
 */

const Business = require('../../models/Business');
const Product = require('../../models/Product');
const { isDbConnected } = require('../../config/db');
const businessService = require('../sellers/businessService');
const productService = require('../products/productService');
const authService = require('../auth/authService');
const logger = require('../../utils/logger');

function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

const storefrontService = {
  /**
   * Resolve public storefront business profile by sellerId or slug
   */
  async resolveStore(identifier) {
    if (!identifier) {
      const err = new Error('Store identifier is required');
      err.statusCode = 400;
      throw err;
    }

    const cleanId = identifier.trim();

    if (isDbConnected()) {
      let biz = await Business.findOne({
        $or: [{ sellerId: cleanId }, { slug: cleanId.toLowerCase() }],
      });

      if (!biz) {
        // Fallback matching slug of name
        const allBiz = await Business.find();
        biz = allBiz.find((b) => slugify(b.name) === cleanId.toLowerCase());
      }

      if (!biz) {
        const err = new Error('Storefront not found');
        err.statusCode = 404;
        throw err;
      }
      return this.formatPublicProfile(biz.toJSON());
    }

    // In-Memory store fallback
    const { businesses } = authService.getMemoryStore();
    let biz = businesses.get(cleanId);

    if (!biz) {
      for (const b of businesses.values()) {
        if (b.slug === cleanId.toLowerCase() || slugify(b.name) === cleanId.toLowerCase()) {
          biz = b;
          break;
        }
      }
    }

    if (!biz) {
      // Lazy load from businessService
      try {
        const resolved = await businessService.getBySellerId(cleanId);
        if (resolved) biz = resolved;
      } catch {}
    }

    if (!biz) {
      const err = new Error('Storefront not found');
      err.statusCode = 404;
      throw err;
    }

    return this.formatPublicProfile(biz);
  },

  formatPublicProfile(biz) {
    const slug = biz.slug || slugify(biz.name);
    return {
      sellerId: biz.sellerId,
      name: biz.name,
      slug,
      description: biz.description || '',
      phone: biz.phone || '',
      email: biz.email || '',
      location: biz.location || '',
      logo: biz.logo || '',
      deliveryInfo: biz.deliveryInfo || 'Standard Delivery',
      deliveryFee: biz.deliveryFee !== undefined ? biz.deliveryFee : 1500,
      deliveryTime: biz.deliveryTime || '1-3 days',
      freeDeliveryThreshold: biz.freeDeliveryThreshold !== undefined ? biz.freeDeliveryThreshold : 25000,
      paymentMethod: biz.paymentMethod || 'both',
      paystackEnabled: biz.paystackEnabled !== false,
      whatsappPhone: biz.whatsappPhone || '',
      whatsappConnected: !!biz.whatsappConnected,
      currency: 'NGN',
      createdAt: biz.createdAt,
    };
  },

  /**
   * Aggregate categories and item counts for a store
   */
  async getCategories(sellerId) {
    const store = await this.resolveStore(sellerId);
    const products = await productService.list({ sellerId: store.sellerId, isPublic: true });

    const categoryMap = new Map();
    for (const p of products) {
      const cat = p.category ? p.category.trim() : 'General';
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
    }

    return Array.from(categoryMap.entries()).map(([name, count]) => ({
      name,
      slug: slugify(name),
      count,
    }));
  },

  /**
   * Search and filter products for public storefront
   */
  async getProducts(sellerId, { category, search, minPrice, maxPrice, inStock, sort = 'newest', page = 1, limit = 20 } = {}) {
    const store = await this.resolveStore(sellerId);
    let products = await productService.list({ sellerId: store.sellerId, isPublic: true });

    // Category filter
    if (category) {
      const catLower = category.toLowerCase();
      products = products.filter(
        (p) => p.category && (p.category.toLowerCase() === catLower || slugify(p.category) === catLower)
      );
    }

    // Keyword search
    if (search) {
      const q = search.toLowerCase().trim();
      products = products.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description && p.description.toLowerCase().includes(q)) ||
          (p.category && p.category.toLowerCase().includes(q))
      );
    }

    // Price bounds
    if (minPrice !== undefined && !isNaN(Number(minPrice))) {
      products = products.filter((p) => p.price >= Number(minPrice));
    }
    if (maxPrice !== undefined && !isNaN(Number(maxPrice))) {
      products = products.filter((p) => p.price <= Number(maxPrice));
    }

    // In-Stock filter
    if (inStock === 'true' || inStock === true) {
      products = products.filter((p) => p.stock > 0);
    }

    // Sorting
    switch (sort) {
      case 'price-asc':
        products.sort((a, b) => a.price - b.price);
        break;
      case 'price-desc':
        products.sort((a, b) => b.price - a.price);
        break;
      case 'name':
        products.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'newest':
      default:
        products.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const total = products.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const paginated = products.slice(startIndex, startIndex + limitNum);

    return {
      store: {
        sellerId: store.sellerId,
        name: store.name,
        slug: store.slug,
      },
      products: paginated,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasMore: pageNum < totalPages,
      },
    };
  },

  /**
   * Get single public product details and related recommendations
   */
  async getProduct(identifier, productId) {
    const store = await this.resolveStore(identifier);
    const product = await productService.getById(productId, store.sellerId);

    if (!product || !product.isActive) {
      const err = new Error('Product not found or currently unavailable');
      err.statusCode = 404;
      throw err;
    }

    // Related products in same category
    const allProducts = await productService.list({ sellerId: store.sellerId, isPublic: true });
    const related = allProducts
      .filter((p) => p.id !== product.id && p.category === product.category)
      .slice(0, 4);

    return {
      store,
      product,
      relatedProducts: related,
    };
  },

  /**
   * Generate OpenGraph, Twitter Cards, and Schema.org metadata for a store
   */
  async getStoreSEO(identifier, baseUrl = 'https://wabac.me') {
    const store = await this.resolveStore(identifier);
    const storeUrl = `${baseUrl}/store/${store.slug || store.sellerId}`;

    const title = `${store.name} | Official WhatsApp Store`;
    const description =
      store.description ||
      `Shop high quality products directly from ${store.name} on WhatsApp. Fast delivery across Nigeria and secure Paystack checkout.`;
    const image = store.logo || `${baseUrl}/static/images/default-storefront-og.png`;

    const openGraph = {
      'og:title': title,
      'og:description': description,
      'og:image': image,
      'og:url': storeUrl,
      'og:type': 'website',
      'og:site_name': store.name,
      'twitter:card': 'summary_large_image',
      'twitter:title': title,
      'twitter:description': description,
      'twitter:image': image,
    };

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'OnlineStore',
      'name': store.name,
      'description': description,
      'url': storeUrl,
      'telephone': store.whatsappPhone || store.phone,
      'currenciesAccepted': 'NGN',
      'paymentAccepted': 'Cash, Credit Card, Bank Transfer',
      'priceRange': '₦₦',
      'image': image,
    };

    return {
      store,
      seo: {
        title,
        description,
        canonicalUrl: storeUrl,
        openGraph,
        structuredData,
      },
    };
  },

  /**
   * Generate OpenGraph, Twitter Cards, and Schema.org Product markup
   */
  async getProductSEO(identifier, productId, baseUrl = 'https://wabac.me') {
    const { store, product } = await this.getProduct(identifier, productId);
    const productUrl = `${baseUrl}/store/${store.slug || store.sellerId}/products/${product.id}`;
    const image = (product.images && product.images[0]) || store.logo || `${baseUrl}/static/images/default-product-og.png`;

    const title = `${product.name} | ${store.name}`;
    const description = product.description || `Buy ${product.name} for ₦${product.price.toLocaleString()} at ${store.name}.`;

    const openGraph = {
      'og:title': title,
      'og:description': description,
      'og:image': image,
      'og:url': productUrl,
      'og:type': 'product',
      'og:site_name': store.name,
      'product:price:amount': product.price,
      'product:price:currency': 'NGN',
      'product:availability': product.stock > 0 ? 'instock' : 'outofstock',
      'twitter:card': 'summary_large_image',
      'twitter:title': title,
      'twitter:description': description,
      'twitter:image': image,
    };

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      'name': product.name,
      'image': product.images || [image],
      'description': description,
      'sku': (product.variants && product.variants[0] && product.variants[0].sku) || product.id,
      'offers': {
        '@type': 'Offer',
        'url': productUrl,
        'priceCurrency': 'NGN',
        'price': product.price,
        'itemCondition': 'https://schema.org/NewCondition',
        'availability': product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        'seller': {
          '@type': 'Organization',
          'name': store.name,
        },
      },
    };

    return {
      store,
      product,
      seo: {
        title,
        description,
        canonicalUrl: productUrl,
        openGraph,
        structuredData,
      },
    };
  },

  /**
   * Generate dynamic XML & JSON Sitemap for search engine indexation
   */
  async getSitemap(identifier, baseUrl = 'https://wabac.me') {
    const store = await this.resolveStore(identifier);
    const products = await productService.list({ sellerId: store.sellerId, isPublic: true });

    const storeSlug = store.slug || store.sellerId;
    const storeUrl = `${baseUrl}/store/${storeSlug}`;

    const urls = [
      {
        loc: storeUrl,
        lastmod: new Date(store.createdAt || Date.now()).toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '1.0',
      },
      ...products.map((p) => ({
        loc: `${storeUrl}/products/${p.id}`,
        lastmod: new Date(p.updatedAt || p.createdAt || Date.now()).toISOString().split('T')[0],
        changefreq: 'weekly',
        priority: '0.8',
      })),
    ];

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
      ...urls.map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      ),
      `</urlset>`,
    ].join('\n');

    return {
      xml,
      json: {
        store: storeSlug,
        totalUrls: urls.length,
        urls,
      },
    };
  },
};

module.exports = storefrontService;
