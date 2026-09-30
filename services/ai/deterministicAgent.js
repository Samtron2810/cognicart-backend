/**
 * Deterministic conversational-commerce state machine.
 *
 * This is intentionally not an LLM imitation. It provides a predictable,
 * restart-safe purchase flow, then delegates every authoritative read/write to
 * the same tenant-scoped tools used by the OpenAI agent.
 */

const { getEffectivePrice } = require('../../models/Product');
const { isEmail } = require('../../utils/validators');
const { comparablePhone } = require('./toolGuards');

const STAGES = Object.freeze({
  BROWSING: 'browsing',
  CHOOSING_PRODUCT: 'choosing_product',
  CHOOSING_VARIANT: 'choosing_variant',
  AWAITING_QUANTITY: 'awaiting_quantity',
  AWAITING_ADDRESS: 'awaiting_address',
  AWAITING_CONTACT: 'awaiting_contact',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  AWAITING_PAYMENT_EMAIL: 'awaiting_payment_email',
  AWAITING_CANCELLATION_CONFIRMATION: 'awaiting_cancellation_confirmation',
});

const YES = new Set(['yes', 'yes please', 'confirm', 'place order', 'confirm order', 'ok', 'okay']);
const NO = new Set(['no', 'cancel', 'cancel order', 'start over', 'restart', 'never mind', 'nevermind']);
const WORD_NUMBERS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9@._:+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(value) {
  return `₦${Number(value || 0).toLocaleString('en-NG')}`;
}

function callId(name) {
  return `call_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function inlineKeyboard(buttons, columns = 1) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += columns) {
    rows.push(buttons.slice(index, index + columns));
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function quantityFromText(value, { strict = false } = {}) {
  const text = normalizeText(value);
  if (!text) return null;

  if (/^\d{1,4}$/.test(text)) return Number(text);
  if (WORD_NUMBERS[text]) return WORD_NUMBERS[text];
  if (strict) return null;

  const numericPatterns = [
    /\b(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\b/,
    /\bx\s*(\d{1,4})\b/,
    /\b(\d{1,4})\s*(?:units?|pieces?|items?|pairs?)\b/,
    /\b(?:buy|order|want|need|get)(?:\s+to)?\s+(\d{1,4})\b/,
  ];
  for (const pattern of numericPatterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  const wordPattern = new RegExp(
    `\\b(?:buy|order|want|need|get)(?:\\s+to)?\\s+(${Object.keys(WORD_NUMBERS).join('|')})\\b`
  );
  const wordMatch = text.match(wordPattern);
  return wordMatch ? WORD_NUMBERS[wordMatch[1]] : null;
}

function stripAddressPrefix(value) {
  return String(value || '')
    .trim()
    .replace(/^(?:my\s+)?(?:delivery\s+)?address\s*(?:is|:|-)?\s*/i, '')
    .replace(/^(?:deliver|delivered|delivery|ship|shipped|send)(?:\s+it)?\s+to\s+/i, '')
    .trim();
}

function validAddress(value) {
  const address = stripAddressPrefix(value);
  return address.length >= 3 && /[a-z]/i.test(address) && !YES.has(normalizeText(address));
}

function parseStructuredRequest(body) {
  const raw = String(body || '').trim();
  const commaParts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 3) {
    const quantity = quantityFromText(commaParts[1], { strict: true });
    if (quantity) {
      return {
        productQuery: commaParts[0],
        quantity,
        address: commaParts.slice(2).join(', '),
        orderIntent: true,
      };
    }
  }

  const deliveryMarker = /\b(?:deliver(?:ed|y)?|ship(?:ped|ping)?|send)(?:\s+it)?\s+to\b/i;
  const marker = raw.match(deliveryMarker);
  const beforeAddress = marker ? raw.slice(0, marker.index).trim() : raw;
  const address = marker ? raw.slice(marker.index + marker[0].length).trim() : '';
  const normalized = normalizeText(raw);

  return {
    productQuery: beforeAddress,
    quantity: quantityFromText(beforeAddress),
    address,
    orderIntent: /\b(?:buy|order|purchase|want|need|get)\b/.test(normalized),
  };
}

const QUERY_PHRASES = [
  /\bi would like to\b/g,
  /\bid like to\b/g,
  /\bi want to\b/g,
  /\bi need to\b/g,
  /\bcan i\b/g,
  /\bcould i\b/g,
  /\bdo you have\b/g,
  /\bshow me\b/g,
  /\blooking for\b/g,
  /\bhow much is\b/g,
  /\bwhat is the price of\b/g,
  /\bprice of\b/g,
];

const QUERY_STOP_WORDS = new Set([
  'i', 'me', 'my', 'please', 'want', 'need', 'would', 'like', 'to', 'buy', 'order',
  'purchase', 'get', 'find', 'search', 'show', 'have', 'some', 'a', 'an', 'the', 'of',
  'for', 'your', 'you', 'sell', 'unit', 'units', 'piece', 'pieces', 'item', 'items', 'pair', 'pairs', 'price',
  'cost', 'available', 'availability', 'stock', 'in', 'is', 'are', 'can', 'could', 'do',
  'size', 'sized', 'colour', 'color',
]);

function extractProductQuery(value, quantity = null) {
  let text = normalizeText(value);
  for (const phrase of QUERY_PHRASES) text = text.replace(phrase, ' ');

  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !QUERY_STOP_WORDS.has(token))
    .filter((token) => !(quantity && /^\d+$/.test(token) && Number(token) === quantity))
    .filter((token) => !(quantity && WORD_NUMBERS[token] === quantity));

  return tokens.join(' ').trim();
}

function variantLabel(variant) {
  return [variant.size, variant.color, variant.sku].filter(Boolean).join(' / ') || 'Option';
}

function availableVariants(product) {
  return (product.variants || []).filter(
    (variant) => variant && variant.id && Number(variant.stock || 0) > 0
  );
}

function resetDraft(state) {
  const lastOrderId = state.lastOrderId || '';
  const lastOrderReference = state.lastOrderReference || '';
  const customerName = state.customerName || '';
  const paymentEmail = state.paymentEmail || '';
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, {
    stage: STAGES.BROWSING,
    lastOrderId,
    lastOrderReference,
    customerName,
    paymentEmail,
  });
  return state;
}

function productList(products, { numbered = false } = {}) {
  return products
    .map((product, index) => {
      const prefix = numbered ? `${index + 1}.` : '•';
      const stock = Number(product.stock || 0);
      return `${prefix} ${product.name} — ${money(product.price)} (${stock > 0 ? `${stock} in stock` : 'out of stock'})`;
    })
    .join('\n');
}

function orderReference(order) {
  return order.reference || (order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : order.id);
}

function extractOrderReference(value, { allowBareNumber = false } = {}) {
  const raw = String(value || '').trim();
  const callback = raw.match(/^(?:track|resume|cancel-order|pay-order):([a-f\d]{24})$/i);
  if (callback) return callback[1];
  const objectId = raw.match(/\b[a-f\d]{24}\b/i);
  if (objectId) return objectId[0];
  const human = raw.match(/(?:#|\b(?:order|ord)[\s#:_-]*)0*(\d+)\b/i);
  if (human) return `#${human[1]}`;
  if (allowBareNumber && /^0*\d+$/.test(raw)) return `#${Number(raw)}`;
  return '';
}

function orderLine(order, index) {
  const names = (order.items || []).map((item) => `${item.name} x${item.quantity}`).join(', ');
  return `${index + 1}. ${orderReference(order)} — ${names || 'Order'} — ${money(order.total)} — ${order.orderStatus} / ${order.paymentStatus}`;
}

function createDeterministicAgent({ tools, sessions }) {
  if (!tools || !sessions) throw new Error('Deterministic agent requires tools and a session adapter');

  async function createTurn(input) {
    const {
      sellerId,
      sessionKey = '',
      toolContext = {},
      customerPhone = '',
      customerName = '',
      businessName = 'Store',
    } = input;
    const state = sessionKey ? await sessions.load(sellerId, sessionKey) : {};
    if (!state.stage) state.stage = STAGES.BROWSING;
    if (customerName) state.customerName = customerName;

    const toolCalls = [];
    const invoke = async (name, args) => {
      const result = await tools[name](sellerId, args, toolContext);
      toolCalls.push({ id: callId(name), name, arguments: args, result });
      return result;
    };
    const finish = async (payload) => {
      if (sessionKey) await sessions.save(sellerId, sessionKey, state);
      return { toolCalls, ...payload };
    };

    return {
      ...input,
      state,
      toolCalls,
      invoke,
      finish,
      hasContact: Boolean(comparablePhone(customerPhone)),
      customerPhone: comparablePhone(customerPhone),
      customerName: customerName || state.customerName || '',
      businessName,
    };
  }

  function productButtons(products) {
    return inlineKeyboard(
      products.map((product, index) => ({
        text: `${index + 1}. ${String(product.name).slice(0, 45)}`,
        callback_data: `product:${product.id}`,
      }))
    );
  }

  function quantityButtons() {
    return inlineKeyboard(
      [1, 2, 3, 4].map((quantity) => ({ text: String(quantity), callback_data: `qty:${quantity}` })),
      4
    );
  }

  function confirmationButtons() {
    return inlineKeyboard([
      { text: 'Confirm order', callback_data: 'confirm:yes' },
      { text: 'Cancel', callback_data: 'confirm:no' },
    ], 2);
  }

  function orderActionButtons(order) {
    const buttons = [{ text: 'Track', callback_data: `track:${order.id}` }];
    if (order.paymentStatus === 'Pending' && ['Pending', 'Confirmed'].includes(order.orderStatus)) {
      buttons.push({ text: 'Pay / resume', callback_data: `pay-order:${order.id}` });
    }
    if (['Pending', 'Confirmed'].includes(order.orderStatus) && order.paymentStatus !== 'Paid') {
      buttons.push({ text: 'Cancel order', callback_data: `cancel-order:${order.id}` });
    }
    return inlineKeyboard(buttons, 1);
  }

  async function listBuyerOrders(turn, { pendingOnly = false } = {}) {
    const orders = await turn.invoke('listOrders', {
      limit: 5,
      ...(pendingOnly ? { paymentStatus: 'Pending' } : {}),
    });
    if (!orders.length) {
      return {
        reply: pendingOnly ? 'You have no pending orders in this Telegram store.' : 'You have no orders in this Telegram store yet.',
        intent: 'orders_empty',
      };
    }
    return {
      reply: `Your recent${pendingOnly ? ' pending' : ''} orders:\n${orders.map(orderLine).join('\n')}\n\nSend “TRACK #00001”, “RESUME #00001”, or “CANCEL ORDER #00001”.`,
      intent: 'orders_listed',
      replyMarkup: inlineKeyboard(
        orders.map((order) => ({
          text: `${orderReference(order)} · ${order.orderStatus}/${order.paymentStatus}`.slice(0, 60),
          callback_data: `track:${order.id}`,
        }))
      ),
    };
  }

  async function trackBuyerOrder(turn, identifier, { resumed = false } = {}) {
    try {
      const order = await turn.invoke('getOrder', { orderId: identifier });
      turn.state.lastOrderId = order.id;
      const items = (order.items || [])
        .map((item) => `• ${item.name}${item.variantLabel ? ` (${item.variantLabel})` : ''} x${item.quantity}`)
        .join('\n');
      const next = order.orderStatus === 'Cancelled'
        ? (order.paymentStatus === 'Refunded'
          ? 'This order is cancelled and its payment has been refunded.'
          : order.paymentStatus === 'Paid'
            ? 'This order is cancelled. Its late payment is being handled through the refund workflow.'
            : 'This order is cancelled and cannot be paid.')
        : order.paymentStatus === 'Refunded'
          ? 'This payment was refunded. Contact the seller if you still need the items.'
          : order.paymentStatus === 'Paid'
            ? `Payment is confirmed. Fulfillment is currently ${order.orderStatus}.`
            : ['Processing', 'Shipped', 'Delivered'].includes(order.orderStatus)
              ? `This unpaid order is already ${order.orderStatus}. Contact the seller before attempting payment or cancellation.`
              : 'Reply “PAY” to continue with the same secure payment link, or “CANCEL ORDER” to cancel.';
      return {
        reply: [
          `${resumed ? 'Order resumed' : 'Order status'}: ${order.reference || identifier}`,
          items,
          `Total: ${money(order.total)}`,
          `Fulfillment: ${order.orderStatus}`,
          `Payment: ${order.paymentStatus}`,
          '',
          next,
        ].filter(Boolean).join('\n'),
        intent: resumed ? 'order_resumed' : 'order_tracked',
        orderId: order.id,
        replyMarkup: orderActionButtons(order),
      };
    } catch {
      return {
        reply: 'I could not find that order in your Telegram purchase history. Check the reference and try again.',
        intent: 'order_not_found',
      };
    }
  }

  async function requestOrderCancellation(turn, identifier) {
    const target = identifier || turn.state.lastOrderId;
    if (!target) {
      return {
        reply: 'Please include the order reference, for example “CANCEL ORDER #00012”, or use “MY ORDERS” first.',
        intent: 'order_reference_required',
      };
    }
    try {
      const order = await turn.invoke('getOrder', { orderId: target });
      if (order.orderStatus === 'Cancelled') {
        return { reply: `${order.reference} is already cancelled.`, intent: 'order_already_cancelled' };
      }
      if (order.paymentStatus === 'Paid' || !['Pending', 'Confirmed'].includes(order.orderStatus)) {
        return {
          reply: `${order.reference} cannot be cancelled in the bot because it is ${order.orderStatus} with payment ${order.paymentStatus}. Please contact the seller.`,
          intent: 'order_not_cancellable',
        };
      }
      turn.state.stage = STAGES.AWAITING_CANCELLATION_CONFIRMATION;
      turn.state.cancellationOrderId = order.id;
      turn.state.cancellationReference = order.reference;
      return {
        reply: `Cancel ${order.reference} for ${money(order.total)}? Reserved stock will be returned. This cannot be undone.`,
        intent: 'cancellation_confirmation_required',
        replyMarkup: inlineKeyboard([
          { text: 'Yes, cancel order', callback_data: 'cancel-confirm:yes' },
          { text: 'Keep order', callback_data: 'cancel-confirm:no' },
        ], 1),
      };
    } catch {
      return {
        reply: 'I could not find that order in your Telegram purchase history.',
        intent: 'order_not_found',
      };
    }
  }

  async function prepareSummary(turn) {
    const { state, invoke } = turn;
    const product = await invoke('getProduct', { productId: state.productId });
    const variants = product.variants || [];
    const variant = state.variantId
      ? variants.find((candidate) => candidate.id === state.variantId)
      : null;
    const stock = variant ? Number(variant.stock || 0) : Number(product.stock || 0);

    if (stock < state.quantity) {
      state.stage = STAGES.AWAITING_QUANTITY;
      return {
        reply: `Only ${stock} ${product.name}${variant ? ` (${variantLabel(variant)})` : ''} currently available. How many would you like?`,
        intent: 'quantity_unavailable',
        replyMarkup: quantityButtons(),
      };
    }

    const total = await invoke('calculateOrderTotal', {
      items: [{
        productId: product.id,
        quantity: state.quantity,
        ...(state.variantId ? { variantId: state.variantId } : {}),
      }],
    });
    state.productName = product.name;
    state.summary = {
      subtotal: total.subtotal,
      deliveryFee: total.deliveryFee,
      total: total.total,
    };

    const summary = [
      'Order Summary:',
      `• ${product.name}${variant ? ` (${variantLabel(variant)})` : ''} x${state.quantity} — ${money(total.subtotal)}`,
      `• Delivery Fee: ${money(total.deliveryFee)}`,
      `• Total Amount: ${money(total.total)}`,
      `• Delivery Address: ${state.address}`,
    ].join('\n');

    if (!turn.hasContact) {
      state.stage = STAGES.AWAITING_CONTACT;
      return {
        reply: `${summary}\n\nYour order details are saved. Tap “Share phone number” below to continue securely.`,
        intent: 'contact_required',
        needsContact: true,
      };
    }

    state.stage = STAGES.AWAITING_CONFIRMATION;
    return {
      reply: `${summary}\n\nPlease confirm that these details are correct by tapping below or replying “YES”.`,
      intent: 'confirm_order',
      replyMarkup: confirmationButtons(),
    };
  }

  async function applyAddress(turn, address) {
    if (!validAddress(address)) {
      turn.state.stage = STAGES.AWAITING_ADDRESS;
      return {
        reply: 'Please send the complete delivery address as a normal message.',
        intent: 'address_required',
      };
    }
    turn.state.address = stripAddressPrefix(address);
    return prepareSummary(turn);
  }

  async function applyQuantity(turn, quantity, prefilledAddress = '') {
    const { state, invoke } = turn;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      state.stage = STAGES.AWAITING_QUANTITY;
      return {
        reply: 'Please enter a valid quantity, for example 1, 2, or 3.',
        intent: 'quantity_required',
        replyMarkup: quantityButtons(),
      };
    }

    const product = await invoke('getProduct', { productId: state.productId });
    const variant = state.variantId
      ? (product.variants || []).find((candidate) => candidate.id === state.variantId)
      : null;
    const stock = variant ? Number(variant.stock || 0) : Number(product.stock || 0);
    if (quantity > stock) {
      state.stage = STAGES.AWAITING_QUANTITY;
      return {
        reply: `Only ${stock} ${product.name}${variant ? ` (${variantLabel(variant)})` : ''} currently available. Please choose a smaller quantity.`,
        intent: 'quantity_unavailable',
        replyMarkup: quantityButtons(),
      };
    }

    state.quantity = quantity;
    if (prefilledAddress) return applyAddress(turn, prefilledAddress);
    state.stage = STAGES.AWAITING_ADDRESS;
    return {
      reply: `Where should we deliver ${quantity} ${product.name}${quantity > 1 ? ' items' : ''}? Send the complete delivery address.`,
      intent: 'address_required',
    };
  }

  async function chooseVariant(turn, product, variant, prefill = {}) {
    turn.state.variantId = variant.id;
    turn.state.variantLabel = variantLabel(variant);
    if (prefill.quantity) return applyQuantity(turn, prefill.quantity, prefill.address);
    turn.state.stage = STAGES.AWAITING_QUANTITY;
    return {
      reply: `You selected ${product.name} (${variantLabel(variant)}). How many would you like?`,
      intent: 'quantity_required',
      replyMarkup: quantityButtons(),
    };
  }

  function inferVariant(product, text) {
    const normalized = normalizeText(text);
    const variants = availableVariants(product);
    return variants.find((variant) => {
      const values = [variant.size, variant.color, variant.sku]
        .filter(Boolean)
        .map(normalizeText);
      return values.length > 0 && values.every((value) => normalized.includes(value));
    });
  }

  async function chooseProduct(turn, productId, prefill = {}) {
    const { state, invoke } = turn;
    const product = await invoke('getProduct', { productId });
    state.productId = product.id;
    state.productName = product.name;
    state.variantId = '';
    state.variantLabel = '';
    state.quantity = null;
    state.address = '';
    state.candidates = [];
    state.pendingInput = null;

    if (Number(product.stock || 0) < 1) {
      resetDraft(state);
      return {
        reply: `${product.name} is currently out of stock. Please choose another product.`,
        intent: 'out_of_stock',
      };
    }

    const variants = availableVariants(product);
    if ((product.variants || []).length > 0) {
      if (variants.length === 0) {
        resetDraft(state);
        return {
          reply: `${product.name} currently has no available variants. Please choose another product.`,
          intent: 'out_of_stock',
        };
      }

      const inferred = inferVariant(product, prefill.raw || '');
      if (inferred) return chooseVariant(turn, product, inferred, prefill);

      state.stage = STAGES.CHOOSING_VARIANT;
      state.pendingInput = { quantity: prefill.quantity || null, address: prefill.address || '' };
      const lines = variants.map((variant, index) => `${index + 1}. ${variantLabel(variant)} — ${variant.stock} in stock`);
      return {
        reply: `${product.name} has these options:\n${lines.join('\n')}\n\nReply with an option number, size, colour, or SKU.`,
        intent: 'variant_required',
        replyMarkup: inlineKeyboard(
          variants.map((variant, index) => ({
            text: `${index + 1}. ${variantLabel(variant)}`.slice(0, 60),
            callback_data: `variant:${variant.id}`,
          }))
        ),
      };
    }

    if (prefill.quantity) return applyQuantity(turn, prefill.quantity, prefill.address);
    state.stage = STAGES.AWAITING_QUANTITY;
    return {
      reply: `I found ${product.name} — ${money(getEffectivePrice(product))} (${product.stock} in stock). How many would you like?`,
      intent: 'quantity_required',
      replyMarkup: quantityButtons(),
    };
  }

  async function searchAndSelect(turn, query, prefill = {}) {
    const products = await turn.invoke('searchProducts', { query, limit: 5 });
    if (products.length === 0) {
      resetDraft(turn.state);
      return {
        reply: `I couldn't find a product matching “${query}”. Try a product type, name, colour, size, or category.`,
        intent: 'no_products',
      };
    }

    if (products.length === 1) return chooseProduct(turn, products[0].id, prefill);

    turn.state.stage = STAGES.CHOOSING_PRODUCT;
    turn.state.candidates = products.map((product) => ({ id: product.id, name: product.name }));
    turn.state.pendingInput = {
      quantity: prefill.quantity || null,
      address: prefill.address || '',
      raw: prefill.raw || '',
    };
    return {
      reply: `I found a few matches:\n${productList(products, { numbered: true })}\n\nReply with a product number or tap your choice.`,
      intent: 'product_choice_required',
      replyMarkup: productButtons(products),
    };
  }

  async function handleProductChoice(turn, body) {
    const normalized = normalizeText(body);
    const callback = normalized.match(/^product:([a-z0-9]+)$/);
    let selected = callback
      ? turn.state.candidates.find((candidate) => candidate.id === callback[1])
      : null;

    if (!selected && /^\d+$/.test(normalized)) {
      selected = turn.state.candidates[Number(normalized) - 1];
    }
    if (!selected) {
      selected = turn.state.candidates.find((candidate) => {
        const name = normalizeText(candidate.name);
        return name === normalized || name.includes(normalized) || normalized.includes(name);
      });
    }

    if (!selected) {
      return {
        reply: `Please choose one of these products:\n${turn.state.candidates
          .map((candidate, index) => `${index + 1}. ${candidate.name}`)
          .join('\n')}`,
        intent: 'product_choice_required',
      };
    }

    const pending = turn.state.pendingInput || {};
    return chooseProduct(turn, selected.id, pending);
  }

  async function handleVariantChoice(turn, body) {
    const product = await turn.invoke('getProduct', { productId: turn.state.productId });
    const variants = availableVariants(product);
    const normalized = normalizeText(body);
    const callback = normalized.match(/^variant:([a-z0-9_-]+)$/);
    let variant = callback
      ? variants.find((candidate) => candidate.id === callback[1])
      : null;

    if (!variant && /^\d+$/.test(normalized)) variant = variants[Number(normalized) - 1];
    if (!variant) variant = inferVariant(product, body);

    if (!variant) {
      return {
        reply: `Please choose a valid option:\n${variants
          .map((candidate, index) => `${index + 1}. ${variantLabel(candidate)}`)
          .join('\n')}`,
        intent: 'variant_required',
      };
    }

    const pending = turn.state.pendingInput || {};
    turn.state.pendingInput = null;
    return chooseVariant(turn, product, variant, pending);
  }

  async function createConfirmedOrder(turn) {
    const { state, invoke } = turn;
    if (!turn.hasContact) {
      state.stage = STAGES.AWAITING_CONTACT;
      return {
        reply: 'Tap “Share phone number” below before confirming your order.',
        intent: 'contact_required',
        needsContact: true,
      };
    }

    const name = state.customerName || turn.customerName || `Customer (${turn.customerPhone.slice(-4)})`;
    const args = {
      customer: {
        name,
        phone: turn.customerPhone,
        address: state.address,
      },
      items: [{
        productId: state.productId,
        quantity: state.quantity,
        ...(state.variantId ? { variantId: state.variantId } : {}),
      }],
      deliveryAddress: state.address,
    };

    try {
      const order = await invoke('createOrder', args);
      const productName = state.productName;
      state.lastOrderId = order.id;
      resetDraft(state);
      state.lastOrderId = order.id;
      state.lastOrderReference = order.reference || (order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : '');
      return {
        reply: [
          '🎉 Order Confirmed!',
          `Order: ${order.reference || (order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : order.id)}`,
          `Product: ${productName}`,
          `Total: ${money(order.total)} (including ${money(order.deliveryFee)} delivery)`,
          `Delivery Address: ${order.deliveryAddress}`,
          '',
          'Reply “PAY” to generate your secure Paystack payment link.',
        ].join('\n'),
        intent: 'order_confirmed',
        orderId: order.id,
      };
    } catch (error) {
      state.stage = STAGES.AWAITING_QUANTITY;
      return {
        reply: `I could not complete the order: ${error.message}\nPlease check the quantity and try again.`,
        intent: 'order_failed',
      };
    }
  }

  async function handlePayment(turn, identifier = '') {
    const target = identifier || turn.state.lastOrderId;
    if (!target) {
      return {
        reply: 'I do not have a recent order to pay. Send “MY ORDERS”, then resume the order you want.',
        intent: 'no_order',
      };
    }

    try {
      const order = await turn.invoke('getOrder', { orderId: target });
      turn.state.lastOrderId = order.id;
      turn.state.lastOrderReference = order.reference || '';
      if (order.orderStatus === 'Cancelled') {
        return { reply: `${order.reference} is cancelled and cannot be paid.`, intent: 'order_cancelled' };
      }
      if (order.paymentStatus === 'Paid') {
        return { reply: `${order.reference} has already been paid.`, intent: 'already_paid', orderId: order.id };
      }
      if (order.paymentStatus === 'Refunded') {
        return { reply: `${order.reference} has been refunded and cannot be paid again.`, intent: 'order_refunded' };
      }
      if (!['Pending', 'Confirmed'].includes(order.orderStatus)) {
        return {
          reply: `${order.reference} is already ${order.orderStatus}. Contact the seller before attempting payment.`,
          intent: 'payment_requires_seller',
          orderId: order.id,
        };
      }
    } catch {
      return { reply: 'I could not find that order in your Telegram purchase history.', intent: 'order_not_found' };
    }

    const email = String(turn.state.paymentEmail || turn.customerEmail || '').trim().toLowerCase();
    if (!isEmail(email)) {
      turn.state.stage = STAGES.AWAITING_PAYMENT_EMAIL;
      turn.state.paymentOrderId = turn.state.lastOrderId;
      return {
        reply: 'Please send a valid email address for Paystack checkout and your payment receipt.',
        intent: 'payment_email_required',
      };
    }

    try {
      const payment = await turn.invoke('createPayment', {
        orderId: turn.state.lastOrderId,
        email,
      });
      turn.state.stage = STAGES.BROWSING;
      turn.state.paymentOrderId = '';
      if (payment.alreadyPaid) {
        return { reply: payment.message, intent: 'already_paid', orderId: turn.state.lastOrderId };
      }
      return {
        reply: [
          `💳 ${payment.reused ? 'Existing payment link' : 'Payment link ready'} for ${turn.state.lastOrderReference || 'your order'}!`,
          `Amount: ${money(payment.amount)}`,
          `Reference: ${payment.reference}`,
          '',
          `Pay now: ${payment.authorization_url}`,
          '',
          'Sending PAY again will return this same pending link, not create another charge.',
        ].join('\n'),
        intent: 'payment_ready',
        orderId: turn.state.lastOrderId,
        paymentReused: Boolean(payment.reused),
      };
    } catch (error) {
      return {
        reply: `I could not generate the payment link: ${error.message}`,
        intent: 'payment_failed',
      };
    }
  }

  async function run(input) {
    const turn = await createTurn(input);
    const rawBody = String(input.body || '').trim();
    const normalized = normalizeText(rawBody);

    if (!rawBody) return turn.finish({ reply: 'Please send a message so I can help.', intent: 'empty' });

    if (turn.state.stage === STAGES.AWAITING_CANCELLATION_CONFIRMATION) {
      const confirmation = normalized === 'cancel-confirm:yes'
        ? 'yes'
        : normalized === 'cancel-confirm:no'
          ? 'no'
          : normalized;
      if (YES.has(confirmation)) {
        try {
          const cancelled = await turn.invoke('cancelOrder', {
            orderId: turn.state.cancellationOrderId,
            reason: 'Cancelled by buyer in Telegram',
          });
          const reference = cancelled.reference || turn.state.cancellationReference || 'Order';
          resetDraft(turn.state);
          turn.state.lastOrderId = cancelled.id;
          turn.state.lastOrderReference = cancelled.reference || '';
          return turn.finish({
            reply: `${reference} has been cancelled. Reserved stock was returned and pending payment links were closed.`,
            intent: 'order_cancelled',
            orderId: cancelled.id,
          });
        } catch (error) {
          resetDraft(turn.state);
          const partial = /order was cancelled/i.test(error.message);
          return turn.finish({
            reply: partial
              ? 'The order is cancelled and must not be paid, but stock restoration needs seller attention. Please contact the seller.'
              : `I could not cancel that order: ${error.message}`,
            intent: partial ? 'cancellation_inventory_review' : 'cancellation_failed',
          });
        }
      }
      if (NO.has(confirmation)) {
        const reference = turn.state.cancellationReference || 'The order';
        resetDraft(turn.state);
        return turn.finish({ reply: `${reference} was kept.`, intent: 'cancellation_declined' });
      }
      return turn.finish({
        reply: 'Please confirm whether to cancel the order.',
        intent: 'cancellation_confirmation_required',
        replyMarkup: inlineKeyboard([
          { text: 'Yes, cancel order', callback_data: 'cancel-confirm:yes' },
          { text: 'Keep order', callback_data: 'cancel-confirm:no' },
        ], 1),
      });
    }

    if (turn.state.stage === STAGES.AWAITING_PAYMENT_EMAIL) {
      if (NO.has(normalized)) {
        turn.state.stage = STAGES.BROWSING;
        turn.state.paymentOrderId = '';
        return turn.finish({ reply: 'Payment was not started. Your order remains pending.', intent: 'payment_cancelled' });
      }
      const email = rawBody.trim().toLowerCase();
      if (!isEmail(email)) {
        return turn.finish({
          reply: 'That email address is not valid. Please enter a valid email, or reply “CANCEL”.',
          intent: 'payment_email_required',
        });
      }
      turn.state.paymentEmail = email;
      turn.state.lastOrderId = turn.state.paymentOrderId || turn.state.lastOrderId;
      return turn.finish(await handlePayment(turn));
    }

    const asksForOrders = /^(?:\/)?orders?$/.test(normalized)
      || /^(?:show|list)(?: me)? (?:my )?orders$/.test(normalized)
      || normalized === 'my orders'
      || normalized === 'order history';
    const asksForPendingOrders = /^(?:show|list)? ?(?:my )?pending orders$/.test(normalized);
    if (asksForOrders || asksForPendingOrders) {
      return turn.finish(await listBuyerOrders(turn, { pendingOnly: asksForPendingOrders }));
    }

    const trackIntent = normalized.startsWith('track:')
      || /^(?:track|check)(?: my)?(?: order)?\b/.test(normalized)
      || /^status(?: of)?(?: my)? order\b/.test(normalized);
    if (trackIntent) {
      const reference = extractOrderReference(rawBody);
      if (!reference) {
        return turn.finish({
          reply: 'Please include the order reference, for example “TRACK #00012”.',
          intent: 'order_reference_required',
        });
      }
      return turn.finish(await trackBuyerOrder(turn, reference));
    }

    const resumeIntent = normalized.startsWith('resume:') || /^resume(?: my)?(?: order)?\b/.test(normalized);
    if (resumeIntent) {
      const reference = extractOrderReference(rawBody) || turn.state.lastOrderId;
      if (!reference) {
        return turn.finish({
          reply: 'Please include the order reference, for example “RESUME #00012”.',
          intent: 'order_reference_required',
        });
      }
      return turn.finish(await trackBuyerOrder(turn, reference, { resumed: true }));
    }

    const cancelOrderIntent = normalized.startsWith('cancel-order:') || /^cancel(?: my)? order\b/.test(normalized);
    if (cancelOrderIntent) {
      return turn.finish(await requestOrderCancellation(turn, extractOrderReference(rawBody)));
    }

    if (normalized === 'cancel payment' || normalized === 'stop payment') {
      return turn.finish({
        reply: 'No payment is taken until you complete Paystack checkout. Your existing link will be reused if you later send PAY. To release stock and close the order, send “CANCEL ORDER”.',
        intent: 'payment_not_completed',
      });
    }

    if (NO.has(normalized) && turn.state.stage !== STAGES.AWAITING_CONFIRMATION) {
      resetDraft(turn.state);
      return turn.finish({
        reply: 'Your current product selection has been cleared. Existing confirmed orders were not cancelled. What product are you looking for?',
        intent: 'cancelled',
      });
    }

    const paymentCallback = normalized.match(/^pay-order:([a-f\d]{24})$/);
    const wantsPayment = Boolean(paymentCallback)
      || normalized === 'pay'
      || normalized.includes('payment link')
      || normalized === 'how to pay'
      || /^pay(?: for)?(?: order)?\b/.test(normalized);
    if (wantsPayment) {
      const reference = paymentCallback ? paymentCallback[1] : extractOrderReference(rawBody);
      return turn.finish(await handlePayment(turn, reference));
    }

    if (turn.state.stage === STAGES.CHOOSING_PRODUCT) {
      return turn.finish(await handleProductChoice(turn, rawBody));
    }
    if (turn.state.stage === STAGES.CHOOSING_VARIANT) {
      return turn.finish(await handleVariantChoice(turn, rawBody));
    }
    if (turn.state.stage === STAGES.AWAITING_QUANTITY) {
      const callback = normalized.match(/^qty:(\d+)$/);
      const quantityAndAddress = rawBody.match(/^\s*(\d{1,4})\s*,\s*(.+)$/);
      const structured = parseStructuredRequest(rawBody);
      const quantity = callback
        ? Number(callback[1])
        : quantityAndAddress
          ? Number(quantityAndAddress[1])
          : quantityFromText(rawBody, { strict: true }) || structured.quantity;
      const address = quantityAndAddress ? quantityAndAddress[2] : structured.address;
      return turn.finish(await applyQuantity(turn, quantity, address));
    }
    if (turn.state.stage === STAGES.AWAITING_ADDRESS) {
      return turn.finish(await applyAddress(turn, rawBody));
    }
    if (turn.state.stage === STAGES.AWAITING_CONTACT) {
      if (!turn.hasContact) {
        return turn.finish({
          reply: 'Your order details are saved. Tap “Share phone number” below to continue.',
          intent: 'contact_required',
          needsContact: true,
        });
      }
      return turn.finish(await prepareSummary(turn));
    }
    if (turn.state.stage === STAGES.AWAITING_CONFIRMATION) {
      const confirmation = normalized === 'confirm:yes' ? 'yes' : normalized === 'confirm:no' ? 'no' : normalized;
      if (YES.has(confirmation)) return turn.finish(await createConfirmedOrder(turn));
      if (NO.has(confirmation)) {
        resetDraft(turn.state);
        return turn.finish({
          reply: 'Order cancelled. What product would you like instead?',
          intent: 'cancelled',
        });
      }

      const changedQuantity = quantityFromText(rawBody, { strict: true });
      if (changedQuantity) return turn.finish(await applyQuantity(turn, changedQuantity, turn.state.address));
      if (/^(?:change\s+)?address\b/i.test(rawBody)) {
        return turn.finish(await applyAddress(turn, rawBody.replace(/^(?:change\s+)?address\s*(?:to|is|:)?\s*/i, '')));
      }
      return turn.finish({
        reply: 'Please confirm the order, or reply “CANCEL”. You can also send a new quantity or type “change address”.',
        intent: 'confirmation_required',
        replyMarkup: confirmationButtons(),
      });
    }

    if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(normalized)) {
      const products = await turn.invoke('searchProducts', { limit: 3 });
      const catalog = products.length
        ? `Top available items:\n${productList(products)}\n\nTell me what you would like to buy.`
        : 'There are no active products in the catalog right now.';
      return turn.finish({
        reply: `Hello! Welcome to ${turn.businessName}. I can help you find products and place an order.\n\n${catalog}`,
        intent: 'greeting',
      });
    }

    const structured = parseStructuredRequest(rawBody);
    const isDeliveryQuestion = /\b(?:delivery|deliver|shipping|location)\b/.test(normalized)
      && !structured.orderIntent
      && !structured.address;
    if (isDeliveryQuestion) {
      const info = await turn.invoke('getBusinessInformation', {});
      return turn.finish({
        reply: `Delivery Information for ${turn.businessName}: ${info.deliveryInfo}. Delivery fee is ${money(info.deliveryFee)} (free over ${money(info.freeDeliveryThreshold)}).`,
        intent: 'business_info',
      });
    }

    if (/^(?:show|list|browse)(?:\s+me)?\s+(?:(?:all|your)\s+)?products?$/.test(normalized)
      || /^(?:what|which) products? (?:do you have|are available)$/.test(normalized)
      || /^(?:what do you sell|what do you have|show me what you have)$/.test(normalized)) {
      const products = await turn.invoke('searchProducts', { limit: 5 });
      return turn.finish({
        reply: products.length
          ? `Available products from ${turn.businessName}:\n${productList(products)}\n\nSend a product name or type to continue.`
          : 'There are no active products in the catalog right now.',
        intent: 'catalog',
      });
    }

    const query = extractProductQuery(structured.productQuery, structured.quantity);
    if (!query) {
      return turn.finish({
        reply: 'What product are you looking for? You can enter a product type, name, colour, size, or category.',
        intent: 'product_query_required',
      });
    }

    return turn.finish(await searchAndSelect(turn, query, {
      quantity: structured.quantity,
      address: structured.address,
      raw: rawBody,
    }));
  }

  async function resumeAfterContact(input) {
    const turn = await createTurn(input);
    if (turn.state.stage !== STAGES.AWAITING_CONTACT || !turn.hasContact) return null;
    return turn.finish(await prepareSummary(turn));
  }

  return {
    run,
    resumeAfterContact,
  };
}

module.exports = {
  STAGES,
  createDeterministicAgent,
  extractProductQuery,
  normalizeText,
  parseStructuredRequest,
  quantityFromText,
  validAddress,
};
