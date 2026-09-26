/**
 * Customer Controller
 * Handles customer queries and profile updates
 */

const customerService = require('../services/customers/customerService');

/**
 * @route   GET /api/customers
 * @desc    List customers belonging to authenticated seller
 * @access  Private
 */
async function getCustomers(req, res, next) {
  try {
    const { search } = req.query;
    const customers = await customerService.list(req.sellerId, { search });
    res.status(200).json(customers);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/customers/:id
 * @desc    Get customer details by ID
 * @access  Private
 */
async function getCustomerById(req, res, next) {
  try {
    const customer = await customerService.getById(req.params.id, req.sellerId);
    res.status(200).json(customer);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/customers
 * @desc    Create a new customer profile under seller
 * @access  Private
 */
async function createCustomer(req, res, next) {
  try {
    const customer = await customerService.create(req.sellerId, req.body);
    res.status(201).json(customer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCustomers,
  getCustomerById,
  createCustomer,
};
