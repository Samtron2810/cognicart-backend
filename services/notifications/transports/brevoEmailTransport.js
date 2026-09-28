/**
 * Brevo Transactional Email Transport
 *
 * Thin adapter around Brevo's v3 transactional-email endpoint. It owns no
 * business logic or templates: callers hand it a fully rendered message and it
 * returns a normalized delivery result. No SDK is needed; Node 20+ provides
 * fetch natively.
 */

const { isEmail } = require('../../../utils/validators');

const DEFAULT_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_TIMEOUT_MS = 10000;

function configuredValue(name) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.startsWith('your_')) return '';
  return value;
}

function getConfig() {
  return {
    apiKey: configuredValue('BREVO_API_KEY'),
    apiUrl: String(process.env.BREVO_API_URL || DEFAULT_API_URL).trim(),
    senderEmail: configuredValue('BREVO_SENDER_EMAIL'),
    senderName: String(process.env.BREVO_SENDER_NAME || 'Store Notifications').trim(),
    timeoutMs: Math.max(1000, Number(process.env.BREVO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.apiKey && isEmail(config.senderEmail) && config.apiUrl);
}

function transportError(message, statusCode, providerResponse) {
  const error = new Error(message);
  error.statusCode = statusCode || 502;
  error.provider = 'brevo';
  if (providerResponse) error.providerResponse = providerResponse;
  return error;
}

async function safelyParse(response) {
  const contentType = response.headers && response.headers.get
    ? response.headers.get('content-type') || ''
    : '';
  try {
    return contentType.includes('application/json') ? await response.json() : await response.text();
  } catch {
    return null;
  }
}

const brevoEmailTransport = {
  channel: 'email',
  provider: 'brevo',
  isConfigured,
  getConfig,

  /**
   * @param {object} message
   * @param {string} message.to
   * @param {string} message.subject
   * @param {string} message.text
   * @param {string} [message.html]
   * @param {{email:string,name?:string}} [message.replyTo]
   * @param {string[]} [message.tags]
   */
  async send(message = {}) {
    const config = getConfig();
    const to = String(message.to || '').trim().toLowerCase();
    const subject = String(message.subject || '').trim();

    if (!config.apiKey || !isEmail(config.senderEmail)) {
      throw transportError('Brevo email transport is not configured', 503);
    }
    if (!isEmail(to)) throw transportError('A valid recipient email is required', 400);
    if (!subject) throw transportError('Email subject is required', 400);
    if (!message.text && !message.html) throw transportError('Email content is required', 400);

    const payload = {
      sender: { email: config.senderEmail, name: config.senderName },
      to: [{ email: to, ...(message.toName ? { name: String(message.toName) } : {}) }],
      subject,
      textContent: String(message.text || ''),
      ...(message.html ? { htmlContent: String(message.html) } : {}),
      ...(Array.isArray(message.tags) && message.tags.length
        ? { tags: message.tags.map((tag) => String(tag)).slice(0, 10) }
        : {}),
    };

    if (message.replyTo && isEmail(message.replyTo.email)) {
      payload.replyTo = {
        email: message.replyTo.email,
        ...(message.replyTo.name ? { name: String(message.replyTo.name) } : {}),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    let response;
    try {
      response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': config.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw transportError(`Brevo request timed out after ${config.timeoutMs}ms`, 504);
      }
      throw transportError(`Brevo request failed: ${error.message}`, 502);
    } finally {
      clearTimeout(timeout);
    }

    const providerResponse = await safelyParse(response);
    if (!response.ok) {
      const detail =
        providerResponse && typeof providerResponse === 'object'
          ? providerResponse.message || providerResponse.code
          : providerResponse;
      throw transportError(
        `Brevo rejected the email (${response.status})${detail ? `: ${detail}` : ''}`,
        502,
        providerResponse
      );
    }

    return {
      delivered: true,
      channel: 'email',
      provider: 'brevo',
      messageId:
        providerResponse && typeof providerResponse === 'object'
          ? providerResponse.messageId || ''
          : '',
      to,
    };
  },
};

module.exports = brevoEmailTransport;
