/**
 * Anonymous Visitor Identity
 *
 * The store chatbot has to remember a conversation for someone who has not
 * signed in. That needs a per-browser identifier — and the identifier is a
 * capability: whoever holds it can read that conversation.
 *
 * So it is NOT accepted from the request body. The server mints a random id,
 * signs it with JWT_SECRET, and returns it in an httpOnly cookie. A client
 * cannot forge one, cannot guess another visitor's, and cannot read its own
 * out of JavaScript. If the signature does not verify the value is discarded
 * and a fresh identity is issued.
 *
 * Without this, `conversationKey` would be a client-supplied string and
 * enumerating other people's chat histories would be trivial.
 */

const crypto = require('crypto');
const { sessionCookieOptions } = require('../utils/sessionCookie');

const VISITOR_COOKIE = 'cs_visitor';
const VISITOR_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is required to sign visitor identities');
  return value;
}

function sign(id) {
  return crypto.createHmac('sha256', secret()).update(`visitor:${id}`).digest('base64url');
}

/** Returns the id when the signature checks out, otherwise ''. */
function parseVisitorCookie(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return '';

  const id = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return '';

  const expected = sign(id);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (signature.length !== expected.length) return '';
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return '';
  return id;
}

function issue() {
  const id = crypto.randomBytes(18).toString('base64url');
  return { id, cookie: `${id}.${sign(id)}` };
}

/**
 * Attach `req.visitorId`, minting and setting the cookie when absent.
 * Always succeeds — an anonymous visitor is a legitimate caller here.
 */
function attachVisitor(req, res, next) {
  try {
    const existing = parseVisitorCookie(req.cookies && req.cookies[VISITOR_COOKIE]);
    if (existing) {
      req.visitorId = existing;
      return next();
    }

    const { id, cookie } = issue();
    req.visitorId = id;
    res.cookie(VISITOR_COOKIE, cookie, sessionCookieOptions(VISITOR_MAX_AGE));
    return next();
  } catch (error) {
    // A missing identity only costs chat persistence; it must never take the
    // storefront down.
    req.visitorId = '';
    return next();
  }
}

module.exports = {
  attachVisitor,
  parseVisitorCookie,
  sign,
  VISITOR_COOKIE,
  VISITOR_MAX_AGE,
};
