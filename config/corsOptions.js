/**
 * CORS Configuration Options
 * Enforces origin validation, credentials, allowed methods and headers
 */

const allowedOrigins = require('./allowedOrigins');

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server, curl, mobile clients, and webhooks with no origin header
    if (!origin) {
      return callback(null, true);
    }

    // Allow configured allowed origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow local development and sandbox preview environments (*.e2b.app)
    if (
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
      /\.e2b\.app$/.test(origin)
    ) {
      return callback(null, true);
    }

    // Fallback in development mode
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    callback(new Error('Blocked by CORS policy: Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Idempotency-Key',
    'X-Hub-Signature-256',
    'X-Paystack-Signature',
    'X-Requested-With',
  ],
  optionsSuccessStatus: 200,
};

module.exports = corsOptions;
