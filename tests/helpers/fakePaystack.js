const http = require('http');

/**
 * Minimal authenticated Paystack test double. Transactions become successful
 * when verified unless setStatus() changes them explicitly.
 */
async function startFakePaystack({ initialStatus = 'success' } = {}) {
  const transactions = new Map();
  const refunds = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ status: false, message: 'Unauthorized' }));
      }
      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const input = JSON.parse(raw || '{}');
        transactions.set(input.reference, { ...input, status: initialStatus });
        return res.end(JSON.stringify({ status: true, data: {
          reference: input.reference,
          authorization_url: `https://checkout.paystack.test/${input.reference}`,
          access_code: `access_${input.reference}`,
        } }));
      }
      if (req.method === 'GET' && req.url.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(req.url.split('/').pop());
        const transaction = transactions.get(reference);
        if (!transaction) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ status: false, message: 'Transaction not found' }));
        }
        return res.end(JSON.stringify({ status: true, data: {
          id: `provider_${reference}`,
          reference,
          status: transaction.status,
          amount: transaction.amount,
          currency: transaction.currency,
        } }));
      }
      if (req.method === 'POST' && req.url === '/refund') {
        const input = JSON.parse(raw || '{}');
        refunds.push(input);
        return res.end(JSON.stringify({ status: true, data: {
          id: `refund_${refunds.length}`,
          status: 'pending',
          transaction: input.transaction,
        } }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ status: false, message: 'Not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    transactions,
    refunds,
    setStatus(reference, status) {
      const transaction = transactions.get(reference);
      if (transaction) transaction.status = status;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakePaystack };
