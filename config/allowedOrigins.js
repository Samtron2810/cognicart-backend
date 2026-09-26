/**
 * List of Allowed Origins for CORS Configuration
 */

const allowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
].filter(Boolean);

module.exports = allowedOrigins;
