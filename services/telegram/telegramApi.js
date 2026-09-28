/**
 * Low-level Telegram Bot API client (no SDK dependency).
 */

const DEFAULT_BASE = 'https://api.telegram.org';

function apiUrl(token, method) {
  const base = String(process.env.TELEGRAM_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  if (base.includes('{token}')) return `${base.replace('{token}', token)}/${method}`;
  return `${base}/bot${token}/${method}`;
}

function telegramError(method, description, statusCode = 502) {
  const error = new Error(`Telegram ${method} failed: ${description}`);
  error.statusCode = statusCode;
  error.provider = 'telegram';
  return error;
}

async function call(token, method, payload = {}, { timeoutMs = 15000 } = {}) {
  if (!token) throw telegramError(method, 'bot token is not configured', 503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(apiUrl(token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw telegramError(method, 'request timed out', 504);
    throw telegramError(method, error.message);
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw telegramError(method, `invalid JSON response (${response.status})`);
  }

  if (!response.ok || !data.ok) {
    throw telegramError(method, data.description || `HTTP ${response.status}`, response.status === 401 ? 401 : 502);
  }
  return data.result;
}

function splitText(text, max = 4000) {
  const input = String(text || '');
  if (input.length <= max) return [input];
  const chunks = [];
  let rest = input;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendText(token, { chatId, text, replyMarkup, disableWebPagePreview = false }) {
  const chunks = splitText(text);
  const results = [];
  for (let index = 0; index < chunks.length; index += 1) {
    results.push(
      await call(token, 'sendMessage', {
        chat_id: String(chatId),
        text: chunks[index],
        disable_web_page_preview: disableWebPagePreview,
        ...(index === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      })
    );
  }
  return results;
}

module.exports = {
  apiUrl,
  call,
  splitText,
  sendText,
  getMe: (token) => call(token, 'getMe'),
  setWebhook: (token, payload) => call(token, 'setWebhook', payload),
  deleteWebhook: (token, payload = {}) => call(token, 'deleteWebhook', payload),
  getWebhookInfo: (token) => call(token, 'getWebhookInfo'),
  getUpdates: (token, payload = {}) =>
    call(token, 'getUpdates', payload, {
      timeoutMs: (Number(payload.timeout) || 25) * 1000 + 10000,
    }),
  answerCallbackQuery: (token, callbackQueryId, text = '') =>
    call(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }),
};
