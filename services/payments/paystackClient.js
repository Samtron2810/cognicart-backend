/**
 * Minimal fail-closed Paystack API client.
 * Secrets never leave the backend and every provider response is validated by
 * the calling payment service before local state changes.
 */

const DEFAULT_BASE_URL = 'https://api.paystack.co';

function providerError(message, statusCode = 502, details = null) {
  const error = new Error(`Paystack: ${message}`);
  error.statusCode = statusCode;
  error.provider = 'paystack';
  error.details = details;
  return error;
}

function secretKey() {
  const key = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!key || key.includes('your_')) {
    throw providerError('PAYSTACK_SECRET_KEY is not configured', 503);
  }
  return key;
}

function baseUrl() {
  return String(process.env.PAYSTACK_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

async function request(method, path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey()}`,
        'Content-Type': 'application/json',
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw providerError('request timed out', 504);
    throw providerError(error.message);
  } finally {
    clearTimeout(timeout);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw providerError(`invalid JSON response (HTTP ${response.status})`);
  }

  if (!response.ok || !body || body.status !== true) {
    const statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw providerError(body && body.message ? body.message : `HTTP ${response.status}`, statusCode, body);
  }
  return body.data;
}

module.exports = {
  request,
  initializeTransaction: (payload) => request('POST', '/transaction/initialize', payload),
  verifyTransaction: (reference) =>
    request('GET', `/transaction/verify/${encodeURIComponent(reference)}`),
  createRefund: (payload) => request('POST', '/refund', payload),
  providerError,
};
