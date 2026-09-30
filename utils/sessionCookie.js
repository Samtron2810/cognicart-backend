/**
 * Browser session cookie policy shared by seller and shopper authentication.
 *
 * The production storefront and API may be hosted on different sites. Those
 * requests are credentialed CORS requests, so SameSite=Strict causes the
 * browser to omit the cookie after a reload/remount (for example when changing
 * responsive views). Production therefore uses the required Secure + None
 * pairing. Local HTTP development uses Lax because browsers reject insecure
 * SameSite=None cookies.
 */

const SELLER_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const SHOPPER_SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function sessionCookieOptions(maxAge) {
  const secureContext =
    process.env.NODE_ENV === 'production' ||
    /^https:\/\//i.test(String(process.env.API_PUBLIC_URL || ''));
  return {
    httpOnly: true,
    secure: secureContext,
    sameSite: secureContext ? 'none' : 'lax',
    // CHIPS keeps cross-site API sessions working when the browser blocks
    // ordinary third-party cookies. Unsupported browsers safely ignore it.
    partitioned: secureContext,
    path: '/',
    maxAge,
    priority: 'high',
  };
}

function sellerSessionCookieOptions() {
  return sessionCookieOptions(SELLER_SESSION_MAX_AGE);
}

function shopperSessionCookieOptions() {
  return sessionCookieOptions(SHOPPER_SESSION_MAX_AGE);
}

function clearSessionCookieOptions() {
  const { maxAge, ...options } = sessionCookieOptions(0);
  return options;
}

module.exports = {
  SELLER_SESSION_MAX_AGE,
  SHOPPER_SESSION_MAX_AGE,
  sessionCookieOptions,
  sellerSessionCookieOptions,
  shopperSessionCookieOptions,
  clearSessionCookieOptions,
};
