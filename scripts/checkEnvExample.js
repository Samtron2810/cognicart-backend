#!/usr/bin/env node
/**
 * Fail when .env.example contains stale, duplicate, or undocumented variables.
 * The template is a deployment contract, not a dump of every optional test hook.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.example');
const expected = [
  'NODE_ENV',
  'PORT',
  'CLIENT_URL',
  'API_PUBLIC_URL',
  'MONGO_URI',
  'JWT_SECRET',
  'BREVO_API_KEY',
  'BREVO_SENDER_EMAIL',
  'BREVO_SENDER_NAME',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'OPENAI_API_KEY',
  'PAYSTACK_SECRET_KEY',
];

// These are intentionally code-level defaults, backwards-compatible aliases,
// test hooks, or advanced tuning controls—not normal deployment inputs.
const intentionallyOmitted = [
  'BREVO_API_URL',
  'BREVO_TIMEOUT_MS',
  'JWT_EXPIRES_IN',
  'LOG_LEVEL',
  'MONGODB_URI',
  'MONGO_SERVER_SELECTION_TIMEOUT_MS',
  'OPENAI_MODEL',
  'PLATFORM_FEE_FIXED',
  'PLATFORM_FEE_PERCENTAGE',
  'SHOPPER_JWT_EXPIRES_IN',
  'SHOP_OTP_DEBUG',
  'TELEGRAM_API_BASE_URL',
  'TELEGRAM_BROADCAST_DELAY_MS',
  'TELEGRAM_POLL_TIMEOUT_SECONDS',
];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const envText = fs.readFileSync(envPath, 'utf8');
const keys = envText
  .split(/\r?\n/)
  .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/))
  .filter(Boolean)
  .map((match) => match[1]);

const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
const unexpected = keys.filter((key) => !expected.includes(key));
const missing = expected.filter((key) => !keys.includes(key));

const runtimeRoots = ['config', 'controllers', 'middleware', 'routes', 'scripts', 'services', 'utils'];
const runtimeFiles = [path.join(root, 'server.js')]
  .concat(runtimeRoots.flatMap((directory) => walk(path.join(root, directory))))
  .filter((file) => path.resolve(file) !== path.resolve(__filename));
const runtimeSource = runtimeFiles
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
const unused = keys.filter((key) => !runtimeSource.includes(key));
const referenced = new Set();
for (const match of runtimeSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
  referenced.add(match[1]);
}
// Brevo's adapter intentionally resolves a small set of variables dynamically.
for (const match of runtimeSource.matchAll(/configuredValue\(['"]([A-Z][A-Z0-9_]*)['"]\)/g)) {
  referenced.add(match[1]);
}
const unclassified = [...referenced].filter(
  (key) => !expected.includes(key) && !intentionallyOmitted.includes(key)
);
const staleOmissions = intentionallyOmitted.filter((key) => !referenced.has(key));

const errors = [];
if (duplicateKeys.length) errors.push(`duplicate keys: ${[...new Set(duplicateKeys)].join(', ')}`);
if (unexpected.length) errors.push(`unexpected keys: ${unexpected.join(', ')}`);
if (missing.length) errors.push(`missing keys: ${missing.join(', ')}`);
if (unused.length) errors.push(`keys not consumed by runtime code: ${unused.join(', ')}`);
if (unclassified.length) errors.push(`runtime variables need classification: ${unclassified.join(', ')}`);
if (staleOmissions.length) errors.push(`stale omitted-variable entries: ${staleOmissions.join(', ')}`);

if (errors.length) {
  console.error(`Invalid .env.example:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log(`.env.example audit passed (${keys.length} runtime variables).`);
