/**
 * Seller and Business Profile Controller
 * Manages seller settings, delivery rates, WhatsApp connection status, and public storefront info
 */

const businessService = require('../services/sellers/businessService');

/**
 * @route   GET /api/business or GET /api/sellers/business
 * @desc    Get authenticated seller's business profile
 * @access  Private
 */
async function getBusiness(req, res, next) {
  try {
    const business = await businessService.getBySellerId(req.sellerId);
    res.status(200).json(business);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   PATCH /api/business or PATCH /api/sellers/business
 * @desc    Update authenticated seller's business profile
 * @access  Private
 */
async function updateBusiness(req, res, next) {
  try {
    const business = await businessService.update(req.sellerId, req.body);
    res.status(200).json(business);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/sellers/:id or GET /api/sellers/:id/storefront
 * @desc    Get public storefront details for a specific seller
 * @access  Public
 */
async function getPublicStorefront(req, res, next) {
  try {
    const { id } = req.params;
    const business = await businessService.getBySellerId(id);
    if (!business) {
      return res.status(404).json({ success: false, message: 'Storefront not found' });
    }

    // Exclude sensitive internal banking info from public storefront
    const publicProfile = {
      id: business.id,
      sellerId: business.sellerId,
      name: business.name,
      description: business.description,
      location: business.location,
      logo: business.logo,
      deliveryInfo: business.deliveryInfo,
      deliveryFee: business.deliveryFee,
      deliveryTime: business.deliveryTime,
      freeDeliveryThreshold: business.freeDeliveryThreshold,
      paymentMethod: business.paymentMethod,
      paystackEnabled: business.paystackEnabled,
      whatsappPhone: business.whatsappPhone,
      whatsappConnected: business.whatsappConnected,
      createdAt: business.createdAt,
    };

    res.status(200).json(publicProfile);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getBusiness,
  updateBusiness,
  getPublicStorefront,
};
