/**
 * Production Rate Limiting Middleware
 * In-memory sliding-window counter protecting endpoints against brute-force attacks and abuse
 */

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 60,
  message = 'Too many requests, please try again later.',
  statusCode = 429,
  keyGenerator = getClientIp,
} = {}) {
  const store = new Map();

  // Periodic cleanup to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(key);
      }
    }
  }, Math.max(windowMs, 60000)).unref();

  return function rateLimiterMiddleware(req, res, next) {
    // Whitelist localhost/internal tests unless explicitly simulating
    const clientKey = keyGenerator(req);
    const now = Date.now();

    let record = store.get(clientKey);

    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      store.set(clientKey, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (record.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(statusCode).json({
        success: false,
        message,
        retryAfter: resetSeconds,
      });
    }

    next();
  };
}

// Pre-configured rate limiters
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
});

const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'API rate limit exceeded. Please reduce request velocity.',
});

const publicLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  message: 'Public storefront request threshold exceeded. Please try again in a few moments.',
});

module.exports = {
  createRateLimiter,
  authLimiter,
  apiLimiter,
  publicLimiter,
};
