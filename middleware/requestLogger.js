/**
 * HTTP Request and Latency Logger Middleware
 */

const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
  });
  next();
}

module.exports = requestLogger;
