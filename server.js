/**
 * Server Entry Point for WABAC Backend
 * Assembles modular middleware, configurations, routes, and bootstraps the HTTP listener
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const corsOptions = require('./config/corsOptions');
const requestLogger = require('./middleware/requestLogger');
const securityHeaders = require('./middleware/securityMiddleware');
const sanitizeInput = require('./middleware/sanitizationMiddleware');
const routes = require('./routes/index');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { connectDB, disconnectDB } = require('./config/db');
const logger = require('./utils/logger');

const app = express();

// Apply production security headers (CSP, HSTS, X-Frame-Options, etc.)
app.use(securityHeaders);

// Apply modular CORS policy
app.use(cors(corsOptions));

// Body parsing with 500KB constraint. Preserve the exact bytes for provider
// webhook HMAC verification; JSON re-serialization is not byte-identical.
app.use(express.json({
  limit: '500kb',
  verify: (req, res, buffer) => {
    const path = String(req.originalUrl || '').split('?')[0].replace(/\/$/, '');
    if (path === '/api/payments/webhook' || path === '/webhooks/paystack') req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use(cookieParser());

// Defend against NoSQL query operator injection
app.use(sanitizeInput);

// Request logging middleware
app.use(requestLogger);

// Mount centralized routes
app.use(routes);

// Centralized error handling
app.use(notFound);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT, 10) || 5000;
const HOST = '0.0.0.0';

let server = null;

// Only start the server if this file is executed directly (not required as a module in tests)
if (require.main === module) {
  // MongoDB is mandatory: the API has no in-memory fallback, so refuse to boot
  // rather than accepting writes that would be silently discarded.
  connectDB()
    .then(() => {
      server = http.createServer(app);
      module.exports.server = server;

      server.listen(PORT, HOST, () => {
        logger.info(`WABAC Server running in ${process.env.NODE_ENV || 'development'} mode on http://${HOST}:${PORT}`);
        logger.info(`Health check live at http://${HOST}:${PORT}/health`);
      });
    })
    .catch((err) => {
      logger.error('FATAL: could not connect to MongoDB. Server not started.', { error: err.message });
      logger.error('Set MONGO_URI to a reachable MongoDB instance and start the server again.');
      process.exit(1);
    });

  // Graceful shutdown
  const handleShutdown = (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);

    const finish = async () => {
      await disconnectDB().catch(() => {});
      logger.info('HTTP server closed.');
      process.exit(0);
    };

    if (server) {
      server.close(finish);
    } else {
      finish();
    }

    setTimeout(() => {
      logger.error('Forcefully terminating process after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

module.exports = app;
module.exports.server = server;
