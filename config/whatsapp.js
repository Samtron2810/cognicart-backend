/**
 * WhatsApp Cloud API Configuration
 */

module.exports = {
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wabac_whatsapp_verify_token_default',
  appSecret: process.env.WHATSAPP_APP_SECRET || '',
};
