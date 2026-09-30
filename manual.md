# Telegram Sales Bot Manual

This guide explains who can create a Telegram sales bot, how to create and connect one, and how it safely uses your store's products and stock information.

## 1. Who can create a Telegram sales bot?

Sellers can create a Telegram bot for automatic sales.

A Telegram sales bot helps a seller:

- Serve customers at any time, including outside business hours.
- Answer common product, price, stock, delivery, and payment questions automatically.
- Display products and variants from the seller's own catalog.
- Collect the information needed to place an order.
- Create orders automatically after the buyer confirms them.
- Give buyers Paystack payment links.
- Deliver order information and updates inside Telegram.
- Keep Telegram orders, customer details, and conversations visible in the seller dashboard.
- Reduce repetitive replies while keeping prices, stock, and orders connected to the store's real records.

## 2. How to create and connect your Telegram bot

### Step 1: Open BotFather

1. Open the Telegram application.
2. Search for **@BotFather**.
3. Select the official, verified BotFather account.
4. Open the chat and press **Start**.

BotFather is Telegram's official tool for creating and managing bots.

### Step 2: Start creating the bot

Send this command to BotFather:

```text
/newbot
```

BotFather will guide you through the remaining creation steps.

### Step 3: Choose the bot's display name

Enter a name that customers will easily associate with your store. For example:

```text
Dan's Fashion Store
```

The display name does not have to be globally unique.

### Step 4: Choose a unique bot username

BotFather will ask you for a username. The username must:

- Be unique across Telegram.
- Contain no spaces.
- End with `bot`.

For example:

```text
DansFashionStoreBot
```

If the username is already in use, choose another variation and try again.

### Step 5: Copy and protect the bot token

After the bot is created, BotFather will provide a token similar to:

```text
123456789:AAExampleLongSecretToken
```

This token is the private credential that allows the application to operate your bot.

- Copy it carefully.
- Do not post it publicly.
- Do not send it to customers.
- Do not include it in screenshots or documentation.
- Only enter it on the Telegram connection page in your seller dashboard.

If the token is ever exposed, open BotFather, use `/revoke`, select the affected bot, and generate a replacement token. Reconnect the bot using the new token.

### Step 6: Add a description and profile image

These steps are optional but recommended because they help buyers recognize and trust the bot.

Use the following BotFather commands:

```text
/setdescription
/setabouttext
/setuserpic
```

BotFather will ask you to select your bot before entering the description, about text, or profile image.

A useful description could be:

```text
Browse our products, check prices and availability, place orders, and receive payment links directly in Telegram.
```

### Step 7: Set the bot commands

Send this command to BotFather:

```text
/setcommands
```

Select your bot and provide these commands:

```text
start - Start shopping
help - Show shopping help
stop - Stop marketing messages
```

These commands make it easier for customers to understand how to use the bot.

### Step 8: Add your store information and products

Before inviting customers to the bot, confirm that your seller dashboard contains accurate information, including:

- Store name and description.
- Delivery information and delivery charges.
- Payment settings.
- Product names and descriptions.
- Product prices and discounts.
- Product variants, such as sizes or colours.
- Current stock quantities.

The bot uses this information when answering customers, so keeping it current produces better answers.

### Step 9: Connect the bot to your store

1. Sign in to your seller dashboard.
2. Open the **Telegram** or **Telegram Integration** page.
3. Paste the bot token you received from BotFather.
4. Click **Connect Bot**.
5. Wait for the connection confirmation.

The application will validate the token, identify the bot, securely connect it to your store, and configure message delivery automatically. You do not need to configure a Telegram webhook manually.

A bot can only be connected to one seller account at a time. Never reuse another seller's bot token.

### Step 10: Test the bot

1. Open the bot using the Telegram link displayed in your seller dashboard, or search for its username.
2. Press **Start**.
3. Try messages such as:

```text
Show me your available products
```

```text
How much is the black shirt?
```

```text
Do you have size 42 in stock?
```

```text
I want two shirts delivered to Ikeja
```

4. When prompted, use Telegram's **Share phone number** button.
5. Follow the instructions to confirm the order and request a payment link.
6. Return to your seller dashboard and confirm that the conversation and order are visible.

Your bot is ready for customers once its answers, products, stock, delivery information, and order flow are correct.

## 3. How the Telegram sales bot works

When a customer opens your bot, the conversation is connected specifically to your store. The bot does not browse or answer from another seller's private catalog.

### Product and stock information

When a customer asks about a product, the application checks your store's current product records. The bot can use information such as:

- Active products in your catalog.
- Product names and descriptions.
- Current prices and active discounts.
- Available stock.
- Sizes, colours, and other variants.
- Delivery fees and free-delivery thresholds.
- Your store's delivery and payment information.

If you update a product, price, discount, variant, or stock quantity in the seller dashboard, future bot enquiries use the updated database information.

The conversational assistant does not have authority to invent an official price or directly change your database. It uses controlled application tools to search products, check stock, calculate totals, create orders, and generate payment links. Before an order is created, the backend checks the selected products, prices, variants, quantities, and stock again using the store's authoritative records.

### Customer conversations and orders

The bot saves incoming and outgoing messages so that you can review customer conversations from your seller dashboard.

A customer may browse and ask questions without immediately placing an order. When the customer is ready to buy, the bot gathers the required order details, including the product, quantity, variant, delivery address, and phone number.

Telegram's **Share phone number** button is used to collect the buyer's number securely. The application verifies that the shared contact belongs to the Telegram user who is speaking with the bot. The customer then receives an order summary and must confirm before the order is created.

A confirmed Telegram order is automatically recorded under your seller account and clearly identified as a Telegram order. The system uses the current catalog price, calculates the applicable delivery charge, records the buyer's Telegram identity, and updates stock through the normal order process.

If the customer requests payment, the backend generates a Paystack checkout link for that specific order. Payment status is confirmed through the application's payment verification process rather than by trusting a chat message.

### Safety and seller protection

The connection is designed to keep stores and customers separated safely:

- Every connected bot is associated with one seller account.
- Product searches and orders are restricted to that seller's catalog.
- A customer's conversation is identified by their Telegram user ID.
- Customers can only retrieve orders that belong to their own conversation identity.
- Bot tokens and webhook secrets are excluded from normal API responses.
- Telegram webhook requests are checked using a private per-bot secret.
- Duplicate Telegram updates are detected to prevent the same message from being processed repeatedly.
- Official prices, totals, stock changes, and payment status are controlled by the backend—not by the customer or conversational assistant.
- The seller can disconnect the bot from the dashboard when necessary.

For the most reliable customer experience, keep your products, stock, prices, variants, delivery settings, and payment configuration accurate in the seller dashboard.