/**
 * Input validation and sanitization utilities
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NIGERIAN_PHONE_REGEX = /^(?:\+234|234|0)[789][01]\d{8}$/;

function isEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim().toLowerCase());
}

function isStrongPassword(password) {
  if (!password || typeof password !== 'string') return false;
  // At least 8 characters, at least 1 uppercase letter, at least 1 number
  return password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

function isNigerianPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-()]/g, '');
  return NIGERIAN_PHONE_REGEX.test(cleaned);
}

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = '+234' + cleaned.slice(1);
  } else if (cleaned.startsWith('234') && !cleaned.startsWith('+234')) {
    cleaned = '+' + cleaned;
  } else if (!cleaned.startsWith('+') && cleaned.length >= 10) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

function sanitize(input, maxLen = 500) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') input = String(input);
  // Strip script tags and potential HTML injections
  let cleaned = input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (maxLen && cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen);
  }
  return cleaned;
}

function clampRequestSize(payloadStr, maxKB = 500) {
  if (!payloadStr) return true;
  const sizeInBytes = Buffer.byteLength(payloadStr, 'utf8');
  return sizeInBytes <= maxKB * 1024;
}

module.exports = {
  isEmail,
  isStrongPassword,
  isNigerianPhone,
  normalizePhone,
  sanitize,
  clampRequestSize,
};
