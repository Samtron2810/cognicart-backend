/**
 * Public Storefront and Discoverability Controller
 * Serves public storefront details, catalog search, SEO metadata, and XML sitemaps
 */

const storefrontService = require('../services/storefront/storefrontService');

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5000';
  return `${protocol}://${host}`;
}

const storefrontController = {
  /**
   * @route   GET /api/storefront/:identifier
   * @desc    Get public storefront profile by seller ID or slug
   * @access  Public
   */
  async getStore(req, res, next) {
    try {
      const store = await storefrontService.resolveStore(req.params.identifier);
      res.status(200).json(store);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/categories
   * @desc    Get store categories and item counts
   * @access  Public
   */
  async getCategories(req, res, next) {
    try {
      const categories = await storefrontService.getCategories(req.params.identifier);
      res.status(200).json(categories);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/products
   * @desc    Search and filter public store products
   * @access  Public
   */
  async getProducts(req, res, next) {
    try {
      const result = await storefrontService.getProducts(req.params.identifier, req.query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/products/:productId
   * @desc    Get public product details and related recommendations
   * @access  Public
   */
  async getProduct(req, res, next) {
    try {
      const result = await storefrontService.getProduct(req.params.identifier, req.params.productId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/seo
   * @desc    Get OpenGraph and Schema.org metadata for store
   * @access  Public
   */
  async getStoreSEO(req, res, next) {
    try {
      const baseUrl = getBaseUrl(req);
      const seo = await storefrontService.getStoreSEO(req.params.identifier, baseUrl);
      res.status(200).json(seo);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/products/:productId/seo
   * @desc    Get OpenGraph, Twitter Cards, and Schema.org Product markup
   * @access  Public
   */
  async getProductSEO(req, res, next) {
    try {
      const baseUrl = getBaseUrl(req);
      const seo = await storefrontService.getProductSEO(req.params.identifier, req.params.productId, baseUrl);
      res.status(200).json(seo);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/sitemap.xml
   * @desc    Get XML Sitemap for store products
   * @access  Public
   */
  async getSitemapXml(req, res, next) {
    try {
      const baseUrl = getBaseUrl(req);
      const { xml } = await storefrontService.getSitemap(req.params.identifier, baseUrl);
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(xml);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/storefront/:identifier/sitemap.json
   * @desc    Get JSON Sitemap for store products
   * @access  Public
   */
  async getSitemapJson(req, res, next) {
    try {
      const baseUrl = getBaseUrl(req);
      const { json } = await storefrontService.getSitemap(req.params.identifier, baseUrl);
      res.status(200).json(json);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = storefrontController;
