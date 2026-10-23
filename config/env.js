/**
 * Environment contract for secrets.
 *
 * JWT_SECRET deliberately has NO code-level default. It does two jobs:
 *   1. signs every seller and buyer JWT, and
 *   2. keys the HMAC that hashes OTP, password-reset, magic-link and
 *      unsubscribe tokens before they are stored.
 * A guessable value therefore lets anyone mint a valid session for any
 * account. It used to fall back to a literal that is published in this
 * repository's git history, so that exact value is now rejected outright:
 * copying it into .env would restore the vulnerability it was meant to fix.
 *
 * Validation happens at require time so a misconfigured deploy fails on boot
 * with an actionable message, rather than at the first login with
 * "secretOrPrivateKey must have a value".
 */

'use strict';

/**
 * Values published in this repository's history. Compromised permanently --
 * rotating away from them is not optional.
 */
const COMPROMISED_SECRETS = new Set([
  'chatstand_jwt_super_secret_dev_key_2026',
  'wabac_jwt_super_secret_dev_key_2026',
  'replace_with_a_long_random_secret',
]);

/** Below this, a secret is brute-forceable offline against a captured token. */
const MIN_SECRET_LENGTH = 32;

const GENERATE_HINT =
  '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"';

let cachedJwtSecret = null;
let warnedAboutLength = false;

function invalidEnv(lines) {
  const error = new Error(lines.join('\n'));
  error.code = 'ENV_INVALID';
  return error;
}

/**
 * Print an ENV_INVALID failure as instructions and exit. Entry points call
 * this so operators get the fix, not a require() stack trace.
 * @param {Error} err
 */
function exitOnInvalidEnv(err) {
  if (err && err.code === 'ENV_INVALID') {
    console.error(`\nFATAL: invalid environment configuration\n\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

/**
 * Resolve JWT_SECRET from the environment, or throw.
 * Memoised: the process reads one value for its whole lifetime.
 * @returns {string}
 */
function getJwtSecret() {
  if (cachedJwtSecret) return cachedJwtSecret;

  const value = typeof process.env.JWT_SECRET === 'string' ? process.env.JWT_SECRET.trim() : '';

  if (!value) {
    throw invalidEnv([
      'JWT_SECRET is not set.',
      '',
      'It signs every seller and buyer session token and keys the HMAC that',
      'hashes OTP, password-reset and magic-link tokens at rest. There is no',
      'default, so the server will not start without it.',
      '',
      'Add it to .env locally, or to the environment variables on your host:',
      '  JWT_SECRET=<a long random string>',
      '',
      'Generate one with:',
      GENERATE_HINT,
    ]);
  }

  if (COMPROMISED_SECRETS.has(value)) {
    throw invalidEnv([
      'JWT_SECRET is set to a known-compromised value.',
      '',
      'This string is public in this repository\'s git history, so anyone can',
      'read it and forge session tokens for any account. It is rejected on',
      'purpose -- using it is no safer than having no secret at all.',
      '',
      'Replace it with a fresh random value:',
      GENERATE_HINT,
    ]);
  }

  if (value.length < MIN_SECRET_LENGTH && !warnedAboutLength) {
    warnedAboutLength = true;
    // Warn rather than refuse: short-but-unique is weak, not broken, and
    // crashing a running deployment over it would be worse than the risk.
    console.warn(
      `[env] WARNING: JWT_SECRET is ${value.length} characters. ` +
        `Use at least ${MIN_SECRET_LENGTH} so it cannot be brute-forced offline.`
    );
  }

  cachedJwtSecret = value;
  return cachedJwtSecret;
}

/**
 * Validate everything that must exist before the process does any work.
 * Called by server.js immediately after dotenv loads, so the failure surfaces
 * as a clean message instead of a require-stack trace.
 */
function assertRequiredEnv() {
  getJwtSecret();
}

module.exports = {
  getJwtSecret,
  assertRequiredEnv,
  exitOnInvalidEnv,
  MIN_SECRET_LENGTH,
  COMPROMISED_SECRETS,
};
