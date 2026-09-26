/**
 * Production Security Headers Middleware
 * Implements defense-in-depth HTTP headers to safeguard against common web vulnerabilities
 */

function securityHeaders(req, res, next) {
  // Disable powered-by header to prevent fingerprinting
  res.removeHeader('X-Powered-By');

  // Prevent MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent Clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS Auditor
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // HTTP Strict Transport Security (HSTS)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict sensitive browser features
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(self)');

  // Content Security Policy (API-safe baseline)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none';"
  );

  next();
}

module.exports = securityHeaders;
