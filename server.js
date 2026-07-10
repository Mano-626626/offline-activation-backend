require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const { verifyInitData } = require("./lib/verifyInitData");
const db = require("./lib/db");
const tg = require("./lib/telegram");
const walletpay = require("./lib/walletpay");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
// Same USD->Stars rate the frontend uses (RATES.STARS in index.html) so
// amounts entered in USD/Stars line up on both sides.
const STARS_PER_USD = 1 / 0.013;
// Sensible guardrails for top-up amounts (in Stars).
const MIN_TOPUP_STARS = 50;
const MAX_TOPUP_STARS = 200000;
// Comma-separated list of origins allowed to call this API, e.g. your GitHub
// Pages URL. "*" works for quick testing but restrict it before going live.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS,
  })
);
// `verify` stashes the raw bytes on the request — needed to check the Wallet
// Pay webhook signature, which is computed over the exact raw request body.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

if (!BOT_TOKEN) {
  console.warn(
    "\n⚠️  BOT_TOKEN is not set. Copy .env.example to .env and fill it in — the server will start but payment routes will fail.\n"
  );
}

// ------------------------------------------------------------------
// Health check (useful for hosting platforms like Render/Railway)
// ------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ------------------------------------------------------------------
// POST /api/create-invoice
// Called by the Mini App when the user taps Pay. Body:
//   { initData: string, items: [{ id: string, qty: number }] }
// Returns:
//   { orderId, invoiceLink }
// ------------------------------------------------------------------
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { initData, items } = req.body || {};

    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized: " + auth.error });
    }
    const user = auth.user;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Look up REAL prices server-side — never trust prices sent by the client.
    const lineItems = [];
    let totalStars = 0;
    for (const line of items) {
      const game = db.getGameById(line.id);
      if (!game) {
        return res.status(400).json({ error: `Unknown game id: ${line.id}` });
      }
      const qty = Math.max(1, Math.min(10, parseInt(line.qty, 10) || 1));
      const amount = game.priceStars * qty;
      totalStars += amount;
      lineItems.push({
        id: game.id,
        title: game.title,
        qty,
        priceStars: game.priceStars,
      });
    }
    if (totalStars <= 0) {
      return res.status(400).json({ error: "Invalid order total" });
    }

    const orderId = "OA-" + crypto.randomBytes(5).toString("hex").toUpperCase();

    const order = {
      id: orderId,
      userId: user.id,
      chatId: user.id, // for private chats with the bot, chat_id === user_id
      username: user.username || null,
      items: lineItems,
      totalStars,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await db.createOrder(order);

    const invoiceLink = await tg.createInvoiceLink({
      title: "Offline Activation order " + orderId,
      description: lineItems.map((i) => `${i.title} ×${i.qty}`).join(", ").slice(0, 250),
      payload: orderId, // echoed back in successful_payment so we know which order got paid
      prices: lineItems.map((i) => ({
        label: `${i.title} ×${i.qty}`,
        amount: i.priceStars * i.qty,
      })),
    });

    res.json({ orderId, invoiceLink });
  } catch (err) {
    console.error("create-invoice error:", err);
    res.status(500).json({ error: "Internal error creating invoice" });
  }
});

// ------------------------------------------------------------------
// GET /api/balance — current wallet balance for the calling user.
// ------------------------------------------------------------------
app.get("/api/balance", (req, res) => {
  const auth = verifyInitData(req.query.initData, BOT_TOKEN);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized: " + auth.error });
  }
  res.json({ balanceStars: db.getBalance(auth.user.id) });
});

// ------------------------------------------------------------------
// POST /api/create-topup-invoice — "Top up with Telegram Stars".
// Body: { initData, amountStars }
// Returns: { orderId, invoiceLink }
// ------------------------------------------------------------------
app.post("/api/create-topup-invoice", async (req, res) => {
  try {
    const { initData, amountStars } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized: " + auth.error });
    }
    const user = auth.user;

    const amount = parseInt(amountStars, 10);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_STARS || amount > MAX_TOPUP_STARS) {
      return res.status(400).json({
        error: `Amount must be between ${MIN_TOPUP_STARS} and ${MAX_TOPUP_STARS} Stars`,
      });
    }

    const orderId = "TOPUP-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const order = {
      id: orderId,
      type: "topup",
      method: "stars",
      userId: user.id,
      chatId: user.id,
      username: user.username || null,
      totalStars: amount,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await db.createOrder(order);

    const invoiceLink = await tg.createInvoiceLink({
      title: "Offline Activation balance top-up",
      description: `Add ${amount} Stars to your balance`,
      payload: orderId,
      prices: [{ label: `Top up ${amount} Stars`, amount }],
    });

    res.json({ orderId, invoiceLink });
  } catch (err) {
    console.error("create-topup-invoice error:", err);
    res.status(500).json({ error: "Internal error creating top-up invoice" });
  }
});

// ------------------------------------------------------------------
// POST /api/create-topup-crypto — "Top up with crypto via Telegram Wallet".
// Body: { initData, amountUsd }
// Returns: { orderId, payLink }
//
// ⚠️ See lib/walletpay.js — this path needs a Wallet Pay merchant account
// and has not been tested against a live one. It will return a clear 503
// error until WALLET_PAY_API_KEY is set, so it fails safely rather than
// silently, but double-check the integration before relying on it.
// ------------------------------------------------------------------
app.post("/api/create-topup-crypto", async (req, res) => {
  try {
    if (!walletpay.isConfigured()) {
      return res.status(503).json({
        error: "Crypto top-ups aren't configured yet — set WALLET_PAY_API_KEY in .env (see backend/README.md).",
      });
    }

    const { initData, amountUsd } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized: " + auth.error });
    }
    const user = auth.user;

    const amount = Number(amountUsd);
    const minUsd = MIN_TOPUP_STARS / STARS_PER_USD;
    const maxUsd = MAX_TOPUP_STARS / STARS_PER_USD;
    if (!Number.isFinite(amount) || amount < minUsd || amount > maxUsd) {
      return res.status(400).json({
        error: `Amount must be between $${minUsd.toFixed(2)} and $${maxUsd.toFixed(0)}`,
      });
    }

    const orderId = "TOPUPX-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const totalStars = Math.round(amount * STARS_PER_USD);

    const order = {
      id: orderId,
      type: "topup",
      method: "crypto",
      userId: user.id,
      chatId: user.id,
      username: user.username || null,
      amountUsd: amount,
      totalStars,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await db.createOrder(order);

    const backendPublicUrl = process.env.PUBLIC_URL; // set this in .env to your deployed backend URL
    if (!backendPublicUrl) {
      return res.status(500).json({ error: "Server misconfigured: PUBLIC_URL is not set in .env" });
    }

    const { payLink } = await walletpay.createOrder({
      orderId,
      amountUsd: amount,
      description: `Offline Activation top-up ${orderId}`,
      customerTelegramUserId: user.id,
      webhookUrl: `${backendPublicUrl.replace(/\/$/, "")}/webhook/walletpay/${WEBHOOK_SECRET}`,
    });

    res.json({ orderId, payLink });
  } catch (err) {
    console.error("create-topup-crypto error:", err);
    res.status(500).json({ error: err.message || "Internal error creating crypto top-up" });
  }
});


app.get("/api/orders", (req, res) => {
  const auth = verifyInitData(req.query.initData, BOT_TOKEN);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized: " + auth.error });
  }
  const orders = db.getOrdersForUser(auth.user.id).filter((o) => o.status === "paid");
  res.json({ orders });
});

// ------------------------------------------------------------------
// POST /webhook/:secret  — Telegram sends updates here.
// Handles: pre_checkout_query (must answer within 10s) and
// message.successful_payment (fulfil the order).
// ------------------------------------------------------------------
app.post("/webhook/:secret", async (req, res) => {
  // Defense in depth: Telegram also sends this as a header when you set
  // secret_token via setWebhook (see lib/telegram.js setWebhook + README).
  const headerSecret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (WEBHOOK_SECRET && req.params.secret !== WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  // Always 200 quickly so Telegram doesn't retry-storm us; do the real work
  // after responding is fine here since Node keeps the process alive for it.
  res.sendStatus(200);

  const update = req.body;

  try {
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query;
      const order = db.getOrderById(pcq.invoice_payload);
      if (!order || order.status !== "pending") {
        await tg.answerPreCheckoutQuery(pcq.id, false, "This order is no longer available.");
      } else {
        await tg.answerPreCheckoutQuery(pcq.id, true);
      }
      return;
    }

    if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      const orderId = sp.invoice_payload;
      const order = await db.markOrderPaid(orderId, sp.telegram_payment_charge_id);
      if (!order) {
        console.error("successful_payment for unknown order:", orderId);
        return;
      }
      if (order.type === "topup") {
        const newBalance = await db.addBalance(order.userId, order.totalStars);
        await tg.sendMessage(
          update.message.chat.id,
          `✅ <b>Balance topped up</b>\n+${order.totalStars} ⭐\n\nNew balance: <b>${newBalance} ⭐</b>`
        );
      } else {
        await deliverOrder(order, update.message.chat.id);
      }
      return;
    }
  } catch (err) {
    console.error("webhook handling error:", err);
  }
});

// ------------------------------------------------------------------
// POST /webhook/walletpay/:secret — Wallet Pay sends crypto payment
// confirmations here. See lib/walletpay.js for the accuracy caveat on this
// integration — verify against current Wallet Pay docs before going live.
// ------------------------------------------------------------------
app.post("/webhook/walletpay/:secret", async (req, res) => {
  if (WEBHOOK_SECRET && req.params.secret !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const signature = req.get("Wpay-Signature");
  if (req.rawBody && !walletpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.error("Wallet Pay webhook: signature mismatch — rejecting.");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const event = req.body || {};
    // NOTE: verify these field names against the live Wallet Pay webhook
    // payload — adjust eventType / externalId access if theirs differs.
    const eventType = event.eventType || event.type;
    const externalId = event.externalId || (event.payload && event.payload.externalId);
    if (eventType !== "ORDER_PAID" || !externalId) return;

    const order = await db.markOrderPaid(externalId, null);
    if (!order) {
      console.error("Wallet Pay payment for unknown order:", externalId);
      return;
    }
    const newBalance = await db.addBalance(order.userId, order.totalStars);
    await tg.sendMessage(
      order.chatId,
      `✅ <b>Balance topped up via crypto</b>\n+${order.totalStars} ⭐ (≈ $${order.amountUsd})\n\nNew balance: <b>${newBalance} ⭐</b>`
    );
  } catch (err) {
    console.error("walletpay webhook handling error:", err);
  }
});

// Sends the purchased account details to the buyer. This is the
// "automatically give the user the item they bought" step.
async function deliverOrder(order, chatId) {
  const lines = [`✅ <b>Payment confirmed</b> — order ${order.id}\n`];
  for (const line of order.items) {
    const game = db.getGameById(line.id);
    const delivery = game && game.delivery;
    lines.push(`🔑 <b>${line.title}</b> ×${line.qty}`);
    if (delivery && delivery.steamLogin && delivery.steamLogin !== "REPLACE_ME") {
      lines.push(`Steam login: <code>${delivery.steamLogin}</code>`);
      lines.push(`Steam password: <code>${delivery.steamPassword}</code>`);
      if (delivery.note) lines.push(delivery.note);
    } else {
      // Catalog entry has no real credentials configured yet — tell the
      // buyer support will follow up instead of sending a broken message.
      lines.push("Our team will send your account details shortly.");
    }
    lines.push("");
  }
  await tg.sendMessage(chatId, lines.join("\n"));
}

app.listen(PORT, () => {
  console.log(`Offline Activation backend listening on port ${PORT}`);
});
