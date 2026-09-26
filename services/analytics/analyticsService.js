/**
 * Seller Analytics and Data Reporting Service
 * Provides sales KPIs, trend aggregations, product performance rankings, and CSV export generators
 */

const orderService = require('../orders/orderService');
const customerService = require('../customers/customerService');
const productService = require('../products/productService');
const paymentService = require('../payments/paymentService');
const payoutService = require('../payouts/payoutService');

function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

const analyticsService = {
  /**
   * Comprehensive seller dashboard overview
   */
  async getOverview(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');

    const [orders, customers, payments, balance] = await Promise.all([
      orderService.list(sellerId),
      customerService.list(sellerId),
      paymentService.list(sellerId),
      payoutService.getBalance(sellerId),
    ]);

    const paidOrders = orders.filter((o) => o.paymentStatus === 'Paid');
    const totalSales = paidOrders.reduce((sum, o) => sum + (o.total || 0), 0);
    const averageOrderValue = paidOrders.length > 0 ? Math.round(totalSales / paidOrders.length) : 0;

    const successfulPayments = payments.filter((p) => p.status === 'success');
    const netEarnings = successfulPayments.reduce((sum, p) => sum + (p.sellerAmount || 0), 0);

    const repeatCustomers = customers.filter((c) => (c.totalOrders || 0) > 1);
    const repeatRate = customers.length > 0 ? Math.round((repeatCustomers.length / customers.length) * 100) : 0;

    return {
      sellerId,
      totalSales,
      netEarnings,
      averageOrderValue,
      orders: {
        total: orders.length,
        paid: paidOrders.length,
        pending: orders.filter((o) => o.orderStatus === 'Pending').length,
        confirmed: orders.filter((o) => o.orderStatus === 'Confirmed').length,
        processing: orders.filter((o) => o.orderStatus === 'Processing').length,
        shipped: orders.filter((o) => o.orderStatus === 'Shipped').length,
        delivered: orders.filter((o) => o.orderStatus === 'Delivered').length,
        cancelled: orders.filter((o) => o.orderStatus === 'Cancelled').length,
      },
      customers: {
        total: customers.length,
        repeatCustomers: repeatCustomers.length,
        repeatRatePercentage: repeatRate,
      },
      settlement: balance,
    };
  },

  /**
   * Sales performance trends aggregated by date
   */
  async getSalesTrends(sellerId, { days = 14 } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const orders = await orderService.list(sellerId);
    const paidOrders = orders.filter((o) => o.paymentStatus === 'Paid');

    const dateMap = new Map();
    const now = new Date();

    // Pre-populate last N days
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dateMap.set(key, { date: key, revenue: 0, ordersCount: 0 });
    }

    for (const order of paidOrders) {
      const dateKey = new Date(order.createdAt).toISOString().split('T')[0];
      if (dateMap.has(dateKey)) {
        const item = dateMap.get(dateKey);
        item.revenue += order.total || 0;
        item.ordersCount += 1;
      }
    }

    return Array.from(dateMap.values());
  },

  /**
   * Top performing products ranked by sales and revenue
   */
  async getTopProducts(sellerId, { limit = 5 } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const [orders, catalog] = await Promise.all([
      orderService.list(sellerId),
      productService.list(sellerId),
    ]);

    const statsMap = new Map();

    for (const order of orders) {
      // Consider all non-cancelled orders
      if (order.orderStatus === 'Cancelled') continue;

      for (const item of order.items || []) {
        const pId = item.productId;
        if (!statsMap.has(pId)) {
          statsMap.set(pId, {
            productId: pId,
            name: item.name,
            unitsSold: 0,
            revenue: 0,
            image: item.image || '',
          });
        }
        const stat = statsMap.get(pId);
        stat.unitsSold += item.quantity || 0;
        stat.revenue += item.subtotal || 0;
      }
    }

    // Attach current stock
    const list = Array.from(statsMap.values()).map((stat) => {
      const liveProduct = catalog.find((p) => p.id === stat.productId);
      return {
        ...stat,
        currentStock: liveProduct ? liveProduct.stock : 0,
        price: liveProduct ? liveProduct.price : 0,
      };
    });

    list.sort((a, b) => b.unitsSold - a.unitsSold || b.revenue - a.revenue);
    return list.slice(0, Number(limit));
  },

  /**
   * Customer retention and lifetime spend metrics
   */
  async getCustomerAnalytics(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');

    const customers = await customerService.list(sellerId);
    const sortedBySpend = [...customers].sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0));

    const totalSpendAll = customers.reduce((sum, c) => sum + (c.totalSpent || 0), 0);
    const avgSpend = customers.length > 0 ? Math.round(totalSpendAll / customers.length) : 0;

    return {
      totalCustomers: customers.length,
      averageSpendPerCustomer: avgSpend,
      topCustomers: sortedBySpend.slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        totalOrders: c.totalOrders,
        totalSpent: c.totalSpent,
        lastOrderAt: c.lastOrderAt,
      })),
    };
  },

  /**
   * Export seller orders to CSV format
   */
  async exportOrdersCSV(sellerId) {
    const orders = await orderService.list(sellerId);

    const headers = [
      'Order ID',
      'Customer Name',
      'Phone',
      'Items Count',
      'Items Summary',
      'Subtotal (NGN)',
      'Delivery Fee (NGN)',
      'Total (NGN)',
      'Payment Status',
      'Order Status',
      'Date',
    ];

    const rows = orders.map((o) => {
      const itemsSummary = (o.items || [])
        .map((i) => `${i.name} (x${i.quantity})`)
        .join('; ');

      return [
        escapeCsvField(o.id),
        escapeCsvField(o.customerName),
        escapeCsvField(o.customerPhone),
        escapeCsvField((o.items || []).length),
        escapeCsvField(itemsSummary),
        escapeCsvField(o.subtotal),
        escapeCsvField(o.deliveryFee),
        escapeCsvField(o.total),
        escapeCsvField(o.paymentStatus),
        escapeCsvField(o.orderStatus),
        escapeCsvField(o.createdAt),
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  },

  /**
   * Export revenue and payment transactions to CSV format
   */
  async exportRevenueCSV(sellerId) {
    const payments = await paymentService.list(sellerId);

    const headers = [
      'Reference',
      'Order ID',
      'Gross Amount (NGN)',
      'Platform Fee (NGN)',
      'Paystack Fee (NGN)',
      'Seller Net (NGN)',
      'Status',
      'Channel',
      'Date',
    ];

    const rows = payments.map((p) => {
      return [
        escapeCsvField(p.reference),
        escapeCsvField(p.orderId),
        escapeCsvField(p.amount),
        escapeCsvField(p.platformFee),
        escapeCsvField(p.paystackFee),
        escapeCsvField(p.sellerAmount),
        escapeCsvField(p.status),
        escapeCsvField(p.channel),
        escapeCsvField(p.createdAt),
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  },
};

module.exports = analyticsService;
