/**
 * Centralized Error Handling Middleware
 */

const logger = require('../utils/logger');

/**
 * 404 Not Found Middleware
 */
function notFound(req, res, next) {
  const error = new Error(`Resource not found - ${req.method} ${req.originalUrl}`);
  res.status(404);
  next(error);
}

/**
 * Global Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
  let statusCode = res.statusCode === 200 ? (err.statusCode || 500) : res.statusCode;
  let message = err.message || 'Internal Server Error';

  // Handle Mongoose Bad ObjectId (CastError)
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 400;
    message = `Resource not found with invalid id: ${err.value}`;
  }

  // Handle Mongoose Validation Error
  if (err.name === 'ValidationError') {
    statusCode = 422;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
  }

  // Handle Mongoose Duplicate Key Error (E11000)
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with this ${field} already exists.`;
  }

  // Handle JWT Errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid authentication token';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Authentication token has expired. Please log in again.';
  }

  // Payload Too Large
  if (err.type === 'entity.too.large' || err.status === 413) {
    statusCode = 413;
    message = 'Payload too large (500KB limit exceeded)';
  }

  logger.error(`${req.method} ${req.originalUrl} - ${statusCode} - ${message}`, {
    ip: req.ip,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    error: err.message,
  });

  res.status(statusCode).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
}

module.exports = {
  notFound,
  errorHandler,
};
