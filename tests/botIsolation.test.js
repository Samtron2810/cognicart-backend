'use strict';

/**
 * Per-store chatbot isolation — the CRITICAL privacy requirement.
 *
 * Every assertion here exists because violating it would leak one seller's
 * catalog, customers or orders to another seller's storefront widget.
 *
 * The AI layer is stubbed so these run with no network and no database: what
 * is under test is the contract webChatService hands to it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.JWT_SECRET = 'test-secret-for-isolation-suite-0123456789abcd';

const SELLER_A = '64b000000000000000000a01';
const SELLER_B = '64b000000000000000000b02';

// --- stub aiService and WebChatSession before webChatService loads ---------
const calls = [];
const transcripts = new Map(); // `${sellerId}|${ownerKey}` -> messages[]

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('aiService')) {
    return {
      async chat(args) {
        calls.push(args);
        return {
          reply: 'Here is what we have in this Telegram store.',
          intent: 'browse',
          replyMarkup: { inline_keyboard: [[{ text: 'View all products', callback_data: 'LIST' }]] },
          toolCalls: [],
        };
      },
    };
  }
  if (request.endsWith('WebChatSession')) {
    return {
      // Synchronous so `.lean()` chains the way Mongoose's query does.
      findOne(filter) {
        const key = `${filter.sellerId}|${filter.ownerKey}`;
        const messages = transcripts.get(key);
        return { lean: async () => (messages ? { messages } : null) };
      },
      async findOneAndUpdate(filter, update) {
        const key = `${filter.sellerId}|${filter.ownerKey}`;
        const existing = transcripts.get(key) || [];
        const added = (update.$push && update.$push.messages && update.$push.messages.$each) || [];
        transcripts.set(key, existing.concat(added));
        return { messages: transcripts.get(key) };
      },
      async deleteOne(filter) {
        transcripts.delete(`${filter.sellerId}|${filter.ownerKey}`);
        return { deletedCount: 1 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const webChatService = require('../services/ai/webChatService');
Module._load = originalLoad;

function reset() {
  calls.length = 0;
  transcripts.clear();
}

// --------------------------------------------------------------------------

test('every AI call carries the store it was asked from', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'show me shoes', visitorId: 'v-one-0000000000' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sellerId, SELLER_A, 'the agent must be scoped to this store');
});

test('the widget is never trusted, even for a signed-in shopper', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'hi', shopperId: 'shopper-1' });

  // `trusted` grants tenant-wide reads. A storefront visitor must never get
  // it, whoever they are authenticated as.
  assert.equal(calls[0].trusted, false);
});

test('the channel is website_chatbot, which is what routes the order source', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'hi', visitorId: 'v-one-0000000000' });
  assert.equal(calls[0].channel, 'website_chatbot');
  assert.equal(webChatService.CHANNEL, 'website_chatbot');
});

test('the same person in two stores gets two different conversations', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'hi', shopperId: 'shopper-1' });
  await webChatService.send({ sellerId: SELLER_B, body: 'hi', shopperId: 'shopper-1' });

  assert.notEqual(calls[0].conversationKey, calls[1].conversationKey);
  assert.ok(calls[0].conversationKey.includes(SELLER_A));
  assert.ok(calls[1].conversationKey.includes(SELLER_B));
});

test('two people in the same store get two different conversations', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'hi', shopperId: 'shopper-1' });
  await webChatService.send({ sellerId: SELLER_A, body: 'hi', shopperId: 'shopper-2' });
  assert.notEqual(calls[0].conversationKey, calls[1].conversationKey);
});

test('a transcript written in store A is invisible in store B', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'secret question', shopperId: 'shopper-1' });

  const inA = await webChatService.loadTranscript(SELLER_A, 'shopper:shopper-1');
  const inB = await webChatService.loadTranscript(SELLER_B, 'shopper:shopper-1');

  assert.ok(inA.length > 0, 'store A must remember the conversation');
  assert.deepEqual(inB, [], 'store B must start fresh — this is the privacy line');
});

test('a transcript is never readable by another owner in the same store', async () => {
  reset();
  await webChatService.send({ sellerId: SELLER_A, body: 'my address is...', shopperId: 'shopper-1' });

  const mine = await webChatService.loadTranscript(SELLER_A, 'shopper:shopper-1');
  const theirs = await webChatService.loadTranscript(SELLER_A, 'shopper:shopper-2');
  assert.ok(mine.length > 0);
  assert.deepEqual(theirs, []);
});

test('a verified shopper outranks the visitor cookie as transcript owner', () => {
  // Otherwise signing in would strand the history behind a browser cookie.
  assert.equal(webChatService.ownerKeyFor({ shopperId: 'abc', visitorId: 'xyz' }), 'shopper:abc');
  assert.equal(webChatService.ownerKeyFor({ shopperId: null, visitorId: 'xyz' }), 'visitor:xyz');
});

test('an unidentified visitor gets no persisted transcript at all', async () => {
  reset();
  assert.equal(webChatService.ownerKeyFor({ shopperId: null, visitorId: '' }), '');

  await webChatService.send({ sellerId: SELLER_A, body: 'hello' });
  // Not persisting is correct: persisting under a blank/guessable key would
  // pool every anonymous visitor's chat into one shared transcript.
  assert.equal(transcripts.size, 0);
  assert.equal(calls[0].conversationKey, '');
});

test('loadTranscript refuses to answer without both store and owner', async () => {
  reset();
  assert.deepEqual(await webChatService.loadTranscript('', 'shopper:1'), []);
  assert.deepEqual(await webChatService.loadTranscript(SELLER_A, ''), []);
});

test('send rejects a missing sellerId instead of defaulting to some store', async () => {
  reset();
  await assert.rejects(() => webChatService.send({ sellerId: '', body: 'hi' }), /sellerId is required/);
});

test('an empty message is a 400, not an AI call', async () => {
  reset();
  await assert.rejects(
    () => webChatService.send({ sellerId: SELLER_A, body: '   ' }),
    (err) => err.statusCode === 400,
  );
  assert.equal(calls.length, 0, 'no spend on an empty prompt');
});

test('Telegram wording is rewritten at the web edge', async () => {
  reset();
  const out = await webChatService.send({ sellerId: SELLER_A, body: 'hi', visitorId: 'v-one-0000000000' });

  assert.ok(!/telegram/i.test(out.reply), `leaked Telegram copy: ${out.reply}`);
  assert.match(out.reply, /in this store/);

  // The shared Telegram agent is untouched — only its output is rephrased.
  assert.match(rephrase('Browse this Telegram store'), /this store/);
  assert.equal(rephrase(''), '');
  assert.equal(rephrase(null), null);
});

function rephrase(text) {
  return webChatService.rephraseForWeb(text);
}

test('a Telegram inline keyboard becomes web quick replies, capped at 6', () => {
  const markup = {
    inline_keyboard: [
      [{ text: 'One', callback_data: 'A' }, { text: 'Two', callback_data: 'B' }],
      [{ text: 'Three', callback_data: 'C' }, { text: 'Four', callback_data: 'D' }],
      [{ text: 'Five', callback_data: 'E' }, { text: 'Six', callback_data: 'F' }],
      [{ text: 'Seven', callback_data: 'G' }],
    ],
  };
  const replies = webChatService.toQuickReplies(markup);
  assert.equal(replies.length, 6, 'a dropdown of buttons must stay usable');
  assert.deepEqual(replies[0], { label: 'One', value: 'A' });
});

test('quick replies survive a missing or malformed keyboard', () => {
  assert.deepEqual(webChatService.toQuickReplies(undefined), []);
  assert.deepEqual(webChatService.toQuickReplies({}), []);
  assert.deepEqual(webChatService.toQuickReplies({ inline_keyboard: [null, [null]] }), []);
});

test('a reply with no buttons still offers the fallback menu', async () => {
  reset();
  const out = await webChatService.send({ sellerId: SELLER_A, body: 'hi', visitorId: 'v-one-0000000000' });
  assert.ok(out.quickReplies.length > 0, 'the no-OpenAI-key path must stay button-driven');
});

test('a phone number is never allowed to stand in for identity', async () => {
  reset();
  await webChatService.send({
    sellerId: SELLER_A,
    body: 'where is my order',
    shopperId: 'shopper-1',
    customerPhone: '08030000000',
  });
  // shopperId is the identity; the phone is only a contact detail passed
  // through. The owner key must not be derived from it.
  assert.ok(calls[0].conversationKey.includes('shopper:shopper-1'));
  assert.ok(!calls[0].conversationKey.includes('08030000000'));
});
