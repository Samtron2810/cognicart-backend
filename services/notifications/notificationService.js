/**
 * Automated WhatsApp Notification Service
 * Dispatches event-driven transactional notifications for order placement, payment receipt, and fulfillment transitions
 */

const businessService = require('../sellers/businessService');
const logger = require('../../utils/logger');

// Lazy-loaded to avoid circular require with whatsappService
function getWhatsAppService() {
  return require('../whatsapp/whatsappService');
}

const notificationService = {
  /**
   * Send WhatsApp Order Confirmation notification to customer
   */
  async sendOrderConfirmation(order) {
    if (!order || !order.customerPhone) return null;

    try {
      const biz = await businessService.getBySellerId(order.sellerId);
      const storeName = (biz && biz.name) || 'Our Store';
      const currency = '₦';

      const itemsSummary = (order.items || [])
        .map((i) => `• ${i.name} (x${i.quantity}) - ${currency}${i.subtotal.toLocaleString()}`)
        .join('\n');

      const messageBody = [
        `🛍️ *Order Confirmed!*`,
        `Hello ${order.customerName || 'Valued Customer'}, thank you for shopping with *${storeName}*!`,
        ``,
        `*Order Reference:* #${order.id}`,
        `*Items:*`,
        itemsSummary,
        ``,
        `*Subtotal:* ${currency}${(order.subtotal || 0).toLocaleString()}`,
        `*Delivery Fee:* ${currency}${(order.deliveryFee || 0).toLocaleString()}`,
        `*Total:* ${currency}${(order.total || 0).toLocaleString()}`,
        `*Delivery Address:* ${order.deliveryAddress || 'Standard Delivery'}`,
        `*Payment Status:* ${order.paymentStatus}`,
        ``,
        `We are preparing your package and will keep you updated. Reply here anytime if you have questions!`,
      ].join('\n');

      const whatsappService = getWhatsAppService();
      const sent = await whatsappService.sendOutbound({
        sellerId: order.sellerId,
        to: order.customerPhone,
        body: messageBody,
      });

      logger.info('Order confirmation notification sent:', { orderId: order.id, to: order.customerPhone });
      return sent;
    } catch (err) {
      logger.warn('Failed to send order confirmation notification:', { error: err.message, orderId: order.id });
      return null;
    }
  },

  /**
   * Send WhatsApp Payment Receipt notification to customer
   */
  async sendPaymentReceipt(payment, order) {
    const toPhone = (order && order.customerPhone) || (payment && payment.customerPhone);
    if (!payment || !toPhone) return null;

    try {
      const sellerId = payment.sellerId || (order && order.sellerId);
      const biz = await businessService.getBySellerId(sellerId);
      const storeName = (biz && biz.name) || 'Our Store';
      const currency = '₦';

      const messageBody = [
        `💳 *Payment Received!*`,
        `Thank you! We have confirmed your payment of *${currency}${(payment.amount || 0).toLocaleString()}* for Order *#${payment.orderId}*.`,
        ``,
        `*Transaction Ref:* ${payment.reference}`,
        `*Store:* ${storeName}`,
        `*Channel:* Paystack Secure Payment`,
        `*Date:* ${new Date().toLocaleDateString()}`,
        ``,
        `Your order is being processed for dispatch. We will send you another update once it's on the way!`,
      ].join('\n');

      const whatsappService = getWhatsAppService();
      const sent = await whatsappService.sendOutbound({
        sellerId,
        to: toPhone,
        body: messageBody,
      });

      logger.info('Payment receipt notification sent:', { reference: payment.reference, to: toPhone });
      return sent;
    } catch (err) {
      logger.warn('Failed to send payment receipt notification:', { error: err.message, reference: payment.reference });
      return null;
    }
  },

  /**
   * Send WhatsApp status update notification (e.g. Shipped, Delivered)
   */
  async sendOrderStatusUpdate(order, newStatus) {
    if (!order || !order.customerPhone) return null;

    try {
      const biz = await businessService.getBySellerId(order.sellerId);
      const storeName = (biz && biz.name) || 'Our Store';

      let statusMsg = '';
      if (newStatus === 'Shipped') {
        statusMsg = '🚚 Your package is on the way! Our courier will contact you shortly.';
      } else if (newStatus === 'Delivered') {
        statusMsg = '🎉 Your package has been marked as Delivered! We hope you love your purchase.';
      } else if (newStatus === 'Confirmed') {
        statusMsg = '✅ Your order has been reviewed and confirmed by our fulfillment team.';
      } else if (newStatus === 'Processing') {
        statusMsg = '📦 We are currently packing your items carefully.';
      } else {
        statusMsg = `Your order status has been updated to: *${newStatus}*.`;
      }

      const messageBody = [
        `📦 *Order Update: #${order.id}*`,
        `Hello ${order.customerName || 'Valued Customer'},`,
        statusMsg,
        ``,
        `*Store:* ${storeName}`,
        `*Current Status:* ${newStatus}`,
        ``,
        `Thank you for choosing ${storeName}!`,
      ].join('\n');

      const whatsappService = getWhatsAppService();
      const sent = await whatsappService.sendOutbound({
        sellerId: order.sellerId,
        to: order.customerPhone,
        body: messageBody,
      });

      logger.info('Order status notification sent:', { orderId: order.id, status: newStatus, to: order.customerPhone });
      return sent;
    } catch (err) {
      logger.warn('Failed to send order status notification:', { error: err.message, orderId: order.id });
      return null;
    }
  },
};

module.exports = notificationService;
