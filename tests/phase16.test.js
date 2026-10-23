/**
 * Phase 16 - Telegram commerce offline contract tests
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const Business = require('../models/Business');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Order = require('../models/Order');
const telegramApi = require('../services/telegram/telegramApi');
const telegramService = require('../services/telegram/telegramService');
const notificationDispatcher = require('../services/notifications/notificationDispatcher');
const messageService = require('../services/messaging/messageService');
const customerService = require('../services/customers/customerService');
const aiService = require('../services/ai/aiService');
const orderService = require('../services/orders/orderService');
const createOrderTool = require('../services/ai/tools/createOrder');
const { buildToolContext, comparablePhone, ownsOrder } = require('../services/ai/toolGuards');
const { getSystemPrompt } = require('../services/ai/prompts/systemPrompt');
const { safeEqual } = require('../middleware/telegramWebhookMiddleware');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function patch(target, replacements) {
  const originals = {};
  for (const [key, value] of Object.entries(replacements)) {
    originals[key] = target[key];
    target[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) target[key] = value;
  };
}

async function main() {
  console.log('\nPhase 16 — Telegram Commerce Tests\n');

  await test('Business JSON never exposes Telegram credentials', () => {
    const business = new Business({
      sellerId: 'seller-1',
      name: 'Safe Store',
      telegramBotToken: 'secret-token',
      telegramWebhookSecret: 'secret-header',
    });
    const json = business.toJSON();
    assert.strictEqual(json.telegramBotToken, undefined);
    assert.strictEqual(json.telegramWebhookSecret, undefined);
    assert.strictEqual(Business.schema.path('telegramBotToken').options.select, false);
    assert.strictEqual(Business.schema.path('telegramWebhookSecret').options.select, false);
  });

  await test('Webhook secret comparison is constant-time compatible and exact', () => {
    assert.strictEqual(safeEqual('same_secret-123', 'same_secret-123'), true);
    assert.strictEqual(safeEqual('same_secret-123', 'wrong_secret'), false);
    assert.strictEqual(safeEqual('', ''), false);
  });

  await test('Telegram update parser preserves sender, chat, contact, and provider ids', () => {
    const parsed = telegramService.parseUpdate({
      update_id: 55,
      message: {
        message_id: 9,
        date: 1700000000,
        from: { id: 123, first_name: 'Ada' },
        chat: { id: 123, type: 'private' },
        contact: { user_id: 123, phone_number: '+2348012345678' },
      },
    });
    assert.strictEqual(parsed.updateId, 55);
    assert.strictEqual(parsed.providerMessageId, '9');
    assert.strictEqual(parsed.from.id, 123);
    assert.strictEqual(parsed.contact.phone_number, '+2348012345678');
    assert.strictEqual(telegramService.isOwnedContact(parsed.contact, parsed.from.id), true);
    assert.strictEqual(telegramService.isOwnedContact({ user_id: 999 }, parsed.from.id), false);
  });

  await test('Contact request keyboard uses Telegram request_contact', () => {
    const keyboard = telegramService.contactKeyboard();
    assert.strictEqual(keyboard.keyboard[0][0].request_contact, true);
    assert.strictEqual(keyboard.one_time_keyboard, true);
  });

  await test('Webhook retry is absorbed before customer or AI side effects', async () => {
    let customerTouched = false;
    const restoreMessages = patch(messageService, {
      findProviderMessage: async () => ({ id: 'existing-inbound' }),
    });
    const restoreCustomers = patch(customerService, {
      upsertChannelIdentity: async () => { customerTouched = true; },
    });
    try {
      const result = await telegramService.handleUpdate({
        business: { sellerId: 'seller-1', telegramBotId: '444', telegramBotToken: 'token' },
        update: {
          update_id: 10,
          message: {
            message_id: 2,
            from: { id: 123 },
            chat: { id: 123, type: 'private' },
            text: 'buy one',
          },
        },
      });
      assert.strictEqual(result.duplicate, true);
      assert.strictEqual(customerTouched, false);
    } finally {
      restoreCustomers();
      restoreMessages();
    }
  });

  await test('A contact belonging to another user is never attached', async () => {
    let attached = false;
    let reply = '';
    const restoreMessages = patch(messageService, {
      findProviderMessage: async () => null,
      getRecentHistory: async () => [],
      saveMessage: async (input) => ({ id: `${input.direction}-1`, ...input }),
    });
    const restoreCustomers = patch(customerService, {
      upsertChannelIdentity: async () => ({ id: 'customer-1', phone: '' }),
      attachPhoneToIdentity: async () => { attached = true; },
    });
    const restoreApi = patch(telegramApi, {
      sendText: async (token, payload) => {
        reply = payload.text;
        return [{ message_id: 3 }];
      },
    });
    try {
      await telegramService.handleUpdate({
        business: { sellerId: 'seller-1', telegramBotId: '444', telegramBotToken: 'token' },
        update: {
          update_id: 11,
          message: {
            message_id: 2,
            from: { id: 123, first_name: 'Ada' },
            chat: { id: 123, type: 'private' },
            contact: { user_id: 999, phone_number: '+2348012345678' },
          },
        },
      });
      assert.strictEqual(attached, false);
      assert(reply.includes('your own phone number'));
    } finally {
      restoreApi();
      restoreCustomers();
      restoreMessages();
    }
  });

  await test('Verified contact resumes a saved deterministic checkout', async () => {
    let resumedContext;
    let sent;
    const restoreMessages = patch(messageService, {
      findProviderMessage: async () => null,
      getRecentHistory: async () => [],
      saveMessage: async (input) => ({ id: `${input.direction}-1`, ...input }),
    });
    const restoreCustomers = patch(customerService, {
      upsertChannelIdentity: async () => ({ id: 'customer-1', phone: '', email: '' }),
      attachPhoneToIdentity: async () => ({
        id: 'customer-1',
        phone: '+2348012345678',
        email: '',
      }),
    });
    const restoreAi = patch(aiService, {
      resumeAfterContact: async (input) => {
        resumedContext = input;
        return { reply: 'Order Summary: Sneakers x2. Reply YES.', toolCalls: [] };
      },
    });
    const restoreApi = patch(telegramApi, {
      sendText: async (token, payload) => {
        sent = payload;
        return [{ message_id: 3 }];
      },
    });
    try {
      await telegramService.handleUpdate({
        business: { sellerId: 'seller-1', telegramBotId: '444', telegramBotToken: 'token' },
        update: {
          update_id: 111,
          message: {
            message_id: 22,
            from: { id: 123, first_name: 'Ada' },
            chat: { id: 123, type: 'private' },
            contact: { user_id: 123, phone_number: '+2348012345678' },
          },
        },
      });
      assert.strictEqual(resumedContext.customerPhone, '+2348012345678');
      assert.strictEqual(resumedContext.channelUserId, '123');
      assert(sent.text.includes('Phone number saved securely'));
      assert(sent.text.includes('Order Summary'));
      assert.strictEqual(sent.replyMarkup.remove_keyboard, true);
    } finally {
      restoreApi();
      restoreAi();
      restoreCustomers();
      restoreMessages();
    }
  });

  await test('AI receives exact Telegram bot and user identity context', async () => {
    let context;
    const restoreMessages = patch(messageService, {
      findProviderMessage: async () => null,
      getRecentHistory: async () => [{ role: 'user', content: 'Earlier' }],
      saveMessage: async (input) => ({ id: `${input.direction}-1`, ...input }),
    });
    const restoreCustomers = patch(customerService, {
      upsertChannelIdentity: async () => ({ id: 'customer-1', phone: '+2348012345678' }),
    });
    const restoreAi = patch(aiService, {
      chat: async (input) => {
        context = input;
        return { reply: 'Ready', toolCalls: [] };
      },
    });
    const restoreApi = patch(telegramApi, {
      sendText: async () => [{ message_id: 3 }],
    });
    try {
      await telegramService.handleUpdate({
        business: { sellerId: 'seller-1', telegramBotId: '444', telegramBotToken: 'token' },
        update: {
          update_id: 12,
          message: {
            message_id: 2,
            from: { id: 123, username: 'ada' },
            chat: { id: 123, type: 'private' },
            text: 'show products',
          },
        },
      });
      assert.strictEqual(context.channel, 'telegram');
      assert.strictEqual(context.channelAccountId, '444');
      assert.strictEqual(context.channelUserId, '123');
      assert.strictEqual(context.customerPhone, '+2348012345678');
      assert.strictEqual(context.conversationKey, 'telegram:123');
    } finally {
      restoreApi();
      restoreAi();
      restoreCustomers();
      restoreMessages();
    }
  });

  await test('Message schema idempotency key includes chat identity', () => {
    const indexes = Message.schema.indexes();
    const index = indexes.find(([, options]) => options.unique && options.partialFilterExpression);
    assert(index, 'expected a unique provider message index');
    assert.deepStrictEqual(Object.keys(index[0]), [
      'channel',
      'channelAccountId',
      'channelUserId',
      'providerMessageId',
    ]);
  });

  await test('Customer schema uniquely scopes Telegram identity per seller', () => {
    const index = Customer.schema.indexes().find(([fields]) => fields['identities.externalId'] === 1);
    assert(index, 'expected external identity index');
    assert.strictEqual(index[1].unique, true);
  });

  await test('Order schema indexes Telegram provenance separately from phone', () => {
    assert(Order.schema.path('channelUserId'));
    const index = Order.schema.indexes().find(([fields]) => fields.channelUserId === 1);
    assert(index, 'expected channel-user order index');
  });

  await test('Telegram order ownership is decisive and never falls back to phone', () => {
    assert.strictEqual(comparablePhone('1234567890'), '');
    const context = buildToolContext({
      sellerId: 'seller-1',
      customerPhone: '+2348012345678',
      channel: 'telegram',
      channelUserId: '123456789',
    });
    const owned = {
      sellerId: 'seller-1',
      customerPhone: '+2348012345678',
      channel: 'telegram',
      channelUserId: '123456789',
    };
    const other = { ...owned, channelUserId: '987654321' };
    assert.strictEqual(ownsOrder(owned, context), true);
    assert.strictEqual(ownsOrder(other, context), false);
  });

  await test('Telegram createOrder tool binds immutable channel provenance', async () => {
    const original = orderService.create;
    let captured;
    orderService.create = async (...args) => {
      captured = args;
      return { id: 'order-1' };
    };
    try {
      await createOrderTool.execute(
        'seller-1',
        {
          customer: { name: 'Ada', phone: 'attacker-controlled' },
          items: [{ productId: 'product-1', quantity: 1 }],
          deliveryAddress: 'Lagos',
        },
        buildToolContext({
          sellerId: 'seller-1',
          customerPhone: '+2348012345678',
          channel: 'telegram',
          channelAccountId: '444',
          channelUserId: '123456789',
          channelUsername: 'ada',
        })
      );
      assert.strictEqual(captured[1].customer.phone, '+2348012345678');
      assert.strictEqual(captured[3].source, 'telegram');
      assert.strictEqual(captured[3].channelUserId, '123456789');
    } finally {
      orderService.create = original;
    }
  });

  await test('Telegram Bot API client sends JSON to the per-bot method URL', async () => {
    const received = {};
    const server = http.createServer((req, res) => {
      received.path = req.url;
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.body = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 88 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const previous = process.env.TELEGRAM_API_BASE_URL;
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const result = await telegramApi.sendText('token-123', { chatId: '42', text: 'Hello' });
      assert.strictEqual(received.path, '/bottoken-123/sendMessage');
      assert.strictEqual(received.body.chat_id, '42');
      assert.strictEqual(result[0].message_id, 88);
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_API_BASE_URL;
      else process.env.TELEGRAM_API_BASE_URL = previous;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('Telegram notification transport is registered', () => {
    const transport = notificationDispatcher.getTransport('telegram');
    assert(transport);
    assert.strictEqual(transport.provider, 'telegram-bot-api');
  });

  await test('Telegram prompt requires contact sharing before checkout', () => {
    const prompt = getSystemPrompt({ businessName: 'Ada Store', channel: 'telegram', contactAvailable: false });
    assert(prompt.includes('Share phone number'));
    assert(prompt.includes('Paystack'));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main();
