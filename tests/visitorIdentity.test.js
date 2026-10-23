'use strict';

/**
 * Anonymous visitor identity.
 *
 * The visitor id is a capability: holding it grants read access to that
 * browser's chat history with a store. Every test here is a security test —
 * if any of them fail, chat transcripts are enumerable by strangers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret-for-visitor-suite-0123456789abcdef';

const {
  attachVisitor,
  parseVisitorCookie,
  sign,
  VISITOR_COOKIE,
  VISITOR_MAX_AGE,
} = require('../middleware/visitorMiddleware');

/** Minimal express double capturing whatever the middleware sets. */
function fakeReqRes(cookies = {}) {
  const res = {
    cookies: {},
    cookie(name, value, options) {
      this.cookies[name] = { value, options };
    },
  };
  return [{ cookies }, res];
}

test('a freshly issued cookie round-trips', () => {
  const [req, res] = fakeReqRes();
  let called = false;
  attachVisitor(req, res, () => {
    called = true;
  });

  assert.equal(called, true, 'middleware must always call next()');
  assert.ok(req.visitorId, 'a visitor id must be minted');

  const issued = res.cookies[VISITOR_COOKIE];
  assert.ok(issued, 'the cookie must be set');
  assert.equal(parseVisitorCookie(issued.value), req.visitorId);
});

test('the cookie is httpOnly and long-lived', () => {
  const [req, res] = fakeReqRes();
  attachVisitor(req, res, () => {});
  const { options } = res.cookies[VISITOR_COOKIE];

  assert.equal(options.httpOnly, true, 'JavaScript must not be able to read the capability');
  assert.equal(options.maxAge, VISITOR_MAX_AGE);
});

test('an existing valid cookie is reused, not reissued', () => {
  const [first, firstRes] = fakeReqRes();
  attachVisitor(first, firstRes, () => {});
  const existing = firstRes.cookies[VISITOR_COOKIE].value;

  const [second, secondRes] = fakeReqRes({ [VISITOR_COOKIE]: existing });
  attachVisitor(second, secondRes, () => {});

  assert.equal(second.visitorId, first.visitorId, 'chat history must survive a reload');
  assert.equal(secondRes.cookies[VISITOR_COOKIE], undefined, 'no need to re-set an intact cookie');
});

test('a forged signature is rejected and a new identity issued', () => {
  const forged = 'aaaaaaaaaaaaaaaaaaaaaaaa.' + 'f'.repeat(43);
  assert.equal(parseVisitorCookie(forged), '');

  const [req, res] = fakeReqRes({ [VISITOR_COOKIE]: forged });
  attachVisitor(req, res, () => {});
  assert.ok(req.visitorId);
  assert.notEqual(req.visitorId, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'a forged id must never be trusted');
  assert.ok(res.cookies[VISITOR_COOKIE], 'a replacement identity must be issued');
});

test("another visitor's id cannot be lifted onto an unsigned cookie", () => {
  const victim = crypto.randomBytes(18).toString('base64url');
  // The attacker knows the id but not JWT_SECRET.
  assert.equal(parseVisitorCookie(victim), '', 'an unsigned id must be refused');
  assert.equal(parseVisitorCookie(`${victim}.`), '');
  assert.equal(parseVisitorCookie(`${victim}.notavalidsignature`), '');

  // With the real signature it works — proving the signature is the gate.
  assert.equal(parseVisitorCookie(`${victim}.${sign(victim)}`), victim);
});

test('a signature from a different secret is rejected', () => {
  const id = crypto.randomBytes(18).toString('base64url');
  const wrong = crypto.createHmac('sha256', 'some-other-secret').update(`visitor:${id}`).digest('base64url');
  assert.equal(parseVisitorCookie(`${id}.${wrong}`), '');
});

test('malformed cookies never throw', () => {
  for (const bad of ['', '.', '..', 'nodot', null, undefined, 42, {}, 'a.b', '.sig', 'x'.repeat(500)]) {
    assert.equal(parseVisitorCookie(bad), '', `rejected: ${String(bad).slice(0, 20)}`);
  }
});

test('an id outside the allowed charset is rejected even if correctly signed', () => {
  // Defence in depth: a signed-but-weird id could still reach a query.
  const nasty = '../../etc/passwd';
  assert.equal(parseVisitorCookie(`${nasty}.${sign(nasty)}`), '');

  const tooShort = 'abc';
  assert.equal(parseVisitorCookie(`${tooShort}.${sign(tooShort)}`), '');
});

test('two visitors get different identities', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    const [req, res] = fakeReqRes();
    attachVisitor(req, res, () => {});
    ids.add(req.visitorId);
  }
  assert.equal(ids.size, 50, 'visitor ids must not collide');
});

test('a missing JWT_SECRET is non-fatal at request time', () => {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const [req, res] = fakeReqRes();
    let called = false;
    attachVisitor(req, res, () => {
      called = true;
    });
    // The page must still render; the visitor is simply unidentified and the
    // chat endpoint will answer 401 rather than leaking a transcript.
    assert.equal(called, true);
    assert.equal(req.visitorId, '');
  } finally {
    process.env.JWT_SECRET = saved;
  }
});
