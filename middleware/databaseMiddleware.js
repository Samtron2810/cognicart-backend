/**
 * Database Availability Middleware
 *
 * The API is backed exclusively by MongoDB. If the connection drops while the
 * process is running, data endpoints fail fast with HTTP 503 instead of
 * falling back to an in-memory store that would silently lose writes.
 */

const { isDbConnected, getDbState } = require('../config/db');
const logger = require('../utils/logger');

function requireDatabase(req, res, next) {
  if (isDbConnected()) return next();

  logger.error('Request rejected: database unavailable', {
    method: req.method,
    url: req.originalUrl,
    dbState: getDbState(),
  });

  return res.status(503).json({
    success: false,
    message: 'Service temporarily unavailable: the database is not reachable. Please retry shortly.',
    database: getDbState(),
  });
}

module.exports = { requireDatabase };
