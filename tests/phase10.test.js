/**
 * Phase 10 - Telegram campaigns, transcripts, and opt-out compliance
 */

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BROADCAST_DELAY_MS = '0';

const http = require('http');
const app = require('../server');
const { setupTestDb, teardownTestDb } = require('./helpers/testDb');
const authService = require('../services/auth/authService');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function runTests() {
  console.log('=== Running Phase 10 Telegram Campaign Tests ===');
  await setupTestDb();

  const telegramRequests = [];
  let messageId = 100;
  const fakeTelegram = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = raw ? JSON.parse(raw) : {};
      telegramRequests.push({ path: req.url, payload });
      let result = true;
      if (req.url.endsWith('/getMe')) {
        result = { id: 444, is_bot: true, username: 'naija_spice_bot' };
      } else if (req.url.endsWith('/sendMessage')) {
        messageId += 1;
        result = { message_id: messageId, chat: { id: payload.chat_id }, text: payload.text };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  const telegramPort = await listen(fakeTelegram);
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${telegramPort}`;

  const server = http.createServer(app);
  const appPort = await listen(server);
  const baseUrl = `http://127.0.0.1:${appPort}`;

  try {
    const registered = await authService.register({
      businessName: 'Naija Spice Hub',
      email: `campaign_${Date.now()}@hub.ng`,
      password: 'Password123!',
      phone: '+2348099999999',
    });
    const token = registered.token;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };

    const connectRes = await fetch(`${baseUrl}/api/telegram/connect`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ botToken: '444:test-token', mode: 'polling' }),
    });
    const connection = await connectRes.json();
    if (connectRes.status !== 201 || !connection.data.connected || connection.data.mode !== 'polling') {
      throw new Error(`Telegram connect failed: ${JSON.stringify(connection)}`);
    }
    if (connection.data.token !== '***configured***' || JSON.stringify(connection).includes('test-token')) {
      throw new Error('Telegram token must be masked');
    }
    console.log('  [PASS] Seller bot connected with masked credentials');

    async function simulate(update) {
      const response = await fetch(`${baseUrl}/api/telegram/simulate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(update),
      });
      const data = await response.json();
      if (response.status !== 200) throw new Error(`Simulation failed: ${JSON.stringify(data)}`);
      return data;
    }

    await simulate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: { id: 7001, first_name: 'Ada', username: 'ada_buyer' },
        chat: { id: 7001, type: 'private' },
        text: '/start',
      },
    });
    console.log('  [PASS] Bot initiation created an eligible Telegram customer');

    const createRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Weekend Offer',
        message: 'Hello {{name}}, welcome to {{store}}!',
        segment: 'ALL',
      }),
    });
    const campaign = await createRes.json();
    if (createRes.status !== 201 || campaign.channel !== 'telegram' || campaign.stats.totalRecipients !== 1) {
      throw new Error(`Campaign creation failed: ${JSON.stringify(campaign)}`);
    }

    const sendRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/send`, {
      method: 'POST',
      headers: authHeaders,
    });
    const sent = await sendRes.json();
    if (sendRes.status !== 200 || sent.stats.sentCount !== 1 || sent.status !== 'completed') {
      throw new Error(`Campaign sending failed: ${JSON.stringify(sent)}`);
    }
    const broadcast = telegramRequests.find(
      (request) => request.path.endsWith('/sendMessage') && request.payload.text.includes('Hello Ada')
    );
    if (!broadcast || broadcast.payload.chat_id !== '7001') {
      throw new Error('Personalized Telegram broadcast not delivered to initiating user');
    }
    console.log('  [PASS] Personalized campaign broadcast delivered');

    await simulate({
      update_id: 2,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        from: { id: 7001, first_name: 'Ada', username: 'ada_buyer' },
        chat: { id: 7001, type: 'private' },
        text: '/stop',
      },
    });

    const optedOutRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'After Stop', message: 'Should not send', segment: 'ALL' }),
    });
    const optedOutCampaign = await optedOutRes.json();
    if (optedOutCampaign.stats.totalRecipients !== 0) {
      throw new Error('Opted-out Telegram user remained in campaign audience');
    }
    console.log('  [PASS] /stop immediately excludes buyer from marketing');

    const transcriptRes = await fetch(`${baseUrl}/api/telegram/messages?channelUserId=7001`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const transcript = await transcriptRes.json();
    if (transcriptRes.status !== 200 || transcript.count < 4 || transcript.data.some((item) => item.channel !== 'telegram')) {
      throw new Error(`Telegram transcript failed: ${JSON.stringify(transcript)}`);
    }
    console.log('  [PASS] Channel transcript stores inbound and outbound messages');

    console.log('=== All Phase 10 Tests Passed Successfully! ===');
  } finally {
    delete process.env.TELEGRAM_API_BASE_URL;
    server.close();
    fakeTelegram.close();
    await teardownTestDb();
  }
}

runTests().catch((error) => {
  console.error('Phase 10 Test Suite Failed:', error);
  process.exit(1);
});
