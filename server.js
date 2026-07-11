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
// Flat reward credited to the referrer's balance after the person they
// invited completes their first game purchase.
const REFERRAL_REWARD_STARS = 50;
// Comma-separated list of origins allowed to call this API, e.g. your GitHub
// Pages URL. "*" works for quick testing but restrict it before going live.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

// Keep this in sync with CONFIG.adminUsernames in the frontend's index.html —
// these are the only two accounts allowed to add/edit/delete games.
const ADMIN_USERNAMES = ["RutuGames", "RutuLljko"];
// Numeric Telegram user IDs (comma-separated in .env) that get a message on
// every sale. Get your own ID from @userinfobot, and make sure you've sent
// /start to your own bot at least once — bots can only message people who
// have already started a chat with them.
const ADMIN_NOTIFY_CHAT_IDS = (process.env.ADMIN_NOTIFY_CHAT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
function isAdminUser(user) {
  if (!user) return false;
  const uname = (user.username || "").replace(/^@/, "").toLowerCase();
  return ADMIN_USERNAMES.map((x) => x.toLowerCase()).includes(uname);
}

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
// GET /api/catalog — public, no auth needed. The Mini App fetches this on
// load so admin edits (title/genre/price/description/image) show up for
// everyone immediately, without re-deploying the frontend.
//
// IMPORTANT: this must NEVER include game.delivery (Steam login/password) —
// that field only leaves the server via deliverOrder(), sent as a private
// Telegram message to a buyer who has actually paid. This endpoint strips it
// out explicitly so a bug elsewhere can't accidentally leak credentials here.
// ------------------------------------------------------------------
app.get("/api/catalog", (req, res) => {
  const publicCatalog = db.getCatalog().map(({ delivery, ...safe }) => safe);
  res.json({ games: publicCatalog });
});

// ------------------------------------------------------------------
// POST /api/admin/games — create a new game. Admin only.
// Body: { initData, title, genre, priceUsd, desc, imageUrl }
// ------------------------------------------------------------------
app.post("/api/admin/games", async (req, res) => {
  try {
    const { initData, title, genre, priceUsd, desc, imageUrl } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized: " + auth.error });
    if (!isAdminUser(auth.user)) return res.status(403).json({ error: "Admin access required" });

    if (!title || !genre || !priceUsd) {
      return res.status(400).json({ error: "title, genre, and priceUsd are required" });
    }

    const catalog = db.getCatalog();
    const nextNum = catalog.length
      ? Math.max(...catalog.map((g) => parseInt((g.id || "g0").replace(/\D/g, ""), 10) || 0)) + 1
      : 1;
    const newGame = {
      id: "g" + nextNum,
      title: String(title).slice(0, 120),
      genre: String(genre).slice(0, 40),
      priceUsd: Number(priceUsd),
      priceStars: Math.max(1, Math.round(Number(priceUsd) * STARS_PER_USD)),
      desc: String(desc || "").slice(0, 500),
      rating: 4.5,
      imageUrl: imageUrl || null,
      delivery: { steamLogin: "REPLACE_ME", steamPassword: "REPLACE_ME", note: "Log into this Steam account, install the game, then switch Steam to Offline Mode." },
    };
    catalog.push(newGame);
    await db.saveCatalog(catalog);

    res.json({ game: newGame });
  } catch (err) {
    console.error("create game error:", err);
    res.status(500).json({ error: "Internal error creating game" });
  }
});

// ------------------------------------------------------------------
// PUT /api/admin/games/:id — edit an existing game. Admin only.
// Body: { initData, title, genre, priceUsd, desc, imageUrl }
// ------------------------------------------------------------------
app.put("/api/admin/games/:id", async (req, res) => {
  try {
    const { initData, title, genre, priceUsd, desc, imageUrl } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized: " + auth.error });
    if (!isAdminUser(auth.user)) return res.status(403).json({ error: "Admin access required" });

    const catalog = db.getCatalog();
    const game = catalog.find((g) => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: "Game not found" });

    if (title !== undefined) game.title = String(title).slice(0, 120);
    if (genre !== undefined) game.genre = String(genre).slice(0, 40);
    if (priceUsd !== undefined) {
      game.priceUsd = Number(priceUsd);
      game.priceStars = Math.max(1, Math.round(Number(priceUsd) * STARS_PER_USD));
    }
    if (desc !== undefined) game.desc = String(desc).slice(0, 500);
    if (imageUrl !== undefined) game.imageUrl = imageUrl || null;

    await db.saveCatalog(catalog);
    res.json({ game });
  } catch (err) {
    console.error("update game error:", err);
    res.status(500).json({ error: "Internal error updating game" });
  }
});

// ------------------------------------------------------------------
// DELETE /api/admin/games/:id — remove a game. Admin only.
// Body: { initData }
// ------------------------------------------------------------------
app.delete("/api/admin/games/:id", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized: " + auth.error });
    if (!isAdminUser(auth.user)) return res.status(403).json({ error: "Admin access required" });

    const catalog = db.getCatalog();
    const idx = catalog.findIndex((g) => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Game not found" });

    catalog.splice(idx, 1);
    await db.saveCatalog(catalog);
    res.json({ ok: true });
  } catch (err) {
    console.error("delete game error:", err);
    res.status(500).json({ error: "Internal error deleting game" });
  }
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
// POST /api/checkout-from-balance — cart "Checkout" now spends the user's
// topped-up balance instead of creating a fresh Stars invoice per order.
// Body: { initData, items: [{ id, qty }] }
// Returns: { orderId, balanceStars }  (balanceStars = new balance after spend)
// 402 if the balance isn't enough (nothing is deducted in that case).
// ------------------------------------------------------------------
app.post("/api/checkout-from-balance", async (req, res) => {
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

    const lineItems = [];
    let totalStars = 0;
    for (const line of items) {
      const game = db.getGameById(line.id);
      if (!game) {
        return res.status(400).json({ error: `Unknown game id: ${line.id}` });
      }
      const qty = Math.max(1, Math.min(10, parseInt(line.qty, 10) || 1));
      totalStars += game.priceStars * qty;
      lineItems.push({ id: game.id, title: game.title, qty, priceStars: game.priceStars });
    }
    if (totalStars <= 0) {
      return res.status(400).json({ error: "Invalid order total" });
    }

    const newBalance = await db.deductBalance(user.id, totalStars);
    if (newBalance === null) {
      return res.status(402).json({
        error: "Insufficient balance",
        requiredStars: totalStars,
        balanceStars: db.getBalance(user.id),
      });
    }

    const orderId = "OA-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const order = {
      id: orderId,
      userId: user.id,
      chatId: user.id,
      username: user.username || null,
      items: lineItems,
      totalStars,
      status: "paid",
      paidVia: "balance",
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
    };
    await db.createOrder(order);
    await deliverOrder(order, user.id); // already paid via balance — deliver immediately, no invoice needed
    await db.rewardReferralIfEligible(user.id, REFERRAL_REWARD_STARS);
    await notifyAdmins(order, user);

    res.json({ orderId, balanceStars: newBalance });
  } catch (err) {
    console.error("checkout-from-balance error:", err);
    res.status(500).json({ error: "Internal error processing checkout" });
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
// GET /api/referral/me — the caller's own referral code + stats.
// Generates a code on first call if they don't have one yet.
// ------------------------------------------------------------------
app.get("/api/referral/me", async (req, res) => {
  const auth = verifyInitData(req.query.initData, BOT_TOKEN);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized: " + auth.error });
  }
  const code = await db.getOrCreateReferralCode(auth.user.id);
  const stats = db.getReferralStats(auth.user.id);
  res.json({ code, invited: stats.invited, converted: stats.converted, earnedStars: stats.earnedStars });
});

// ------------------------------------------------------------------
// POST /api/referral/register — called once, the first time a NEW user
// opens the app via someone's referral link (?startapp=CODE).
// Body: { initData, code }
// ------------------------------------------------------------------
app.post("/api/referral/register", async (req, res) => {
  const { initData, code } = req.body || {};
  const auth = verifyInitData(initData, BOT_TOKEN);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized: " + auth.error });
  }
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing referral code" });
  }
  const result = await db.registerReferral(auth.user.id, code.toUpperCase());
  res.json(result);
});

// ------------------------------------------------------------------
// POST /api/admin/grant-balance — TEMPORARY, for testing only.
// Lets an admin credit their OWN balance without paying, so they can test
// checkout without spending real Stars. Remove this route before a real
// public launch — search "GRANT-BALANCE-TESTING" to find it fast.
// GRANT-BALANCE-TESTING
// Body: { initData, amountStars }
// ------------------------------------------------------------------
app.post("/api/admin/grant-balance", async (req, res) => {
  try {
    const { initData, amountStars } = req.body || {};
    const auth = verifyInitData(initData, BOT_TOKEN);
    if (!auth.ok) return res.status(401).json({ error: "Unauthorized: " + auth.error });
    if (!isAdminUser(auth.user)) return res.status(403).json({ error: "Admin access required" });

    const amount = parseInt(amountStars, 10);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: "amountStars must be between 1 and 100000" });
    }
    const newBalance = await db.addBalance(auth.user.id, amount);
    res.json({ balanceStars: newBalance });
  } catch (err) {
    console.error("grant-balance error:", err);
    res.status(500).json({ error: "Internal error granting balance" });
  }
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
        await db.rewardReferralIfEligible(order.userId, REFERRAL_REWARD_STARS);
        await notifyAdmins(order, update.message.from || { id: order.userId, username: order.username });
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

// Sends a sale alert to the shop owner(s) — separate from the buyer's own
// confirmation message. Configure ADMIN_NOTIFY_CHAT_IDS in .env to use this.
async function notifyAdmins(order, buyer) {
  if (ADMIN_NOTIFY_CHAT_IDS.length === 0) return; // not configured — silently skip
  const buyerName = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ") || "Unknown";
  const buyerHandle = buyer.username ? `@${buyer.username}` : "no username";
  const itemsText = order.items.map(i => `${i.title} ×${i.qty}`).join(", ");
  const when = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const text = [
    `🛒 <b>New sale</b>`,
    `👤 ${buyerName} (${buyerHandle}) — ID: <code>${buyer.id}</code>`,
    `🎮 ${itemsText}`,
    `💰 ${order.totalStars} ⭐ (≈ $${(order.totalStars * 0.013).toFixed(2)})`,
    `🕒 ${when}`,
    `📦 Order: <code>${order.id}</code>`,
  ].join("\n");
  for (const chatId of ADMIN_NOTIFY_CHAT_IDS) {
    try { await tg.sendMessage(chatId, text); } catch (e) { console.error("notifyAdmins failed for", chatId, e.message); }
  }
}

app.listen(PORT, () => {
  console.log(`Offline Activation backend listening on port ${PORT}`);
});

