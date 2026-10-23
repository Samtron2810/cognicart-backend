/**
 * Phase 20 - durable browser session cookie contracts
 */

const assert = require('assert');
const authController = require('../controllers/authController');
const shopController = require('../controllers/shopController');
const authService = require('../services/auth/authService');
const shopperAuthService = require('../services/shop/shopperAuthService');
const { SHOPPER_COOKIE } = require('../middleware/shopperMiddleware');
const {
  SELLER_SESSION_MAX_AGE,
  SHOPPER_SESSION_MAX_AGE,
  sellerSessionCookieOptions,
  shopperSessionCookieOptions,
  clearSessionCookieOptions,
} = require('../utils/sessionCookie');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.stack || error.message}`);
  }
}

function fakeResponse() {
  return {
    cookieCall: null,
    clearCookieCall: null,
    statusCode: null,
    payload: null,
    cookie(name, value, options) {
      this.cookieCall = { name, value, options };
      return this;
    },
    clearCookie(name, options) {
      this.clearCookieCall = { name, options };
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function main() {
  console.log('\nPhase 20 — Durable Browser Session Tests\n');
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiPublicUrl = process.env.API_PUBLIC_URL;

  await test('Production cookies support credentialed cross-site API requests', () => {
    process.env.NODE_ENV = 'production';
    const seller = sellerSessionCookieOptions();
    const shopper = shopperSessionCookieOptions();

    for (const options of [seller, shopper]) {
      assert.strictEqual(options.httpOnly, true);
      assert.strictEqual(options.secure, true);
      assert.strictEqual(options.sameSite, 'none');
      assert.strictEqual(options.partitioned, true);
      assert.strictEqual(options.path, '/');
      assert.strictEqual(options.priority, 'high');
    }
    assert.strictEqual(seller.maxAge, SELLER_SESSION_MAX_AGE);
    assert.strictEqual(shopper.maxAge, SHOPPER_SESSION_MAX_AGE);
  });

  await test('A public HTTPS API gets the durable policy even outside production mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.API_PUBLIC_URL = 'https://api.example.test';
    const options = sellerSessionCookieOptions();
    assert.strictEqual(options.secure, true);
    assert.strictEqual(options.sameSite, 'none');
    assert.strictEqual(options.partitioned, true);
  });

  await test('Local HTTP cookies remain accepted by browsers', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.API_PUBLIC_URL;
    const options = sellerSessionCookieOptions();
    assert.strictEqual(options.secure, false);
    assert.strictEqual(options.sameSite, 'lax');
    assert.strictEqual(options.partitioned, false);
    assert.strictEqual(options.path, '/');
  });

  await test('Seller login issues the durable cookie and logout clears the same scope', async () => {
    process.env.NODE_ENV = 'production';
    const originalLogin = authService.login;
    authService.login = async () => ({
      token: 'seller-token',
      seller: { id: 'seller-1', email: 'seller@example.com' },
    });
    try {
      const response = fakeResponse();
      let forwarded;
      await authController.login(
        { body: { email: 'seller@example.com', password: 'Password1' } },
        response,
        (error) => { forwarded = error; }
      );
      assert.strictEqual(forwarded, undefined);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.cookieCall.name, 'token');
      assert.strictEqual(response.cookieCall.value, 'seller-token');
      assert.strictEqual(response.cookieCall.options.sameSite, 'none');
      assert.strictEqual(response.cookieCall.options.secure, true);

      const logoutResponse = fakeResponse();
      authController.logout({}, logoutResponse);
      assert.deepStrictEqual(logoutResponse.clearCookieCall, {
        name: 'token',
        options: clearSessionCookieOptions(),
      });
    } finally {
      authService.login = originalLogin;
    }
  });

  await test('Shopper verification uses the same durable browser policy', async () => {
    process.env.NODE_ENV = 'production';
    const originalVerifyOtp = shopperAuthService.verifyOtp;
    shopperAuthService.verifyOtp = async () => ({ token: 'shopper-token', shopper: { id: 'shopper-1' } });
    try {
      const response = fakeResponse();
      let forwarded;
      await shopController.verifyOtp(
        { body: { phone: '+2348012345678', email: 'buyer@example.com', code: '123456' } },
        response,
        (error) => { forwarded = error; }
      );
      assert.strictEqual(forwarded, undefined);
      assert.strictEqual(response.cookieCall.name, SHOPPER_COOKIE);
      assert.strictEqual(response.cookieCall.options.sameSite, 'none');
      assert.strictEqual(response.cookieCall.options.secure, true);

      const logoutResponse = fakeResponse();
      await shopController.logout({}, logoutResponse);
      assert.deepStrictEqual(logoutResponse.clearCookieCall, {
        name: SHOPPER_COOKIE,
        options: clearSessionCookieOptions(),
      });
    } finally {
      shopperAuthService.verifyOtp = originalVerifyOtp;
    }
  });

  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
  else process.env.API_PUBLIC_URL = originalApiPublicUrl;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
