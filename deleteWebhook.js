// Client for Wallet Pay (https://pay.wallet.tg) — Telegram's official crypto
// payment product, used to accept crypto through the built-in Telegram
// Wallet. This is a SEPARATE product from the Bot API / Stars — it needs its
// own merchant account and its own API key (WALLET_PAY_API_KEY in .env).
//
// ⚠️ IMPORTANT — read before going live:
// I wrote this against my general knowledge of Wallet Pay's REST API shape,
// but I do not have a live merchant account to test it against, and payment
// APIs like this do change their exact field names over time. Before
// accepting a single real payment through this path:
//   1. Create a merchant account at https://pay.wallet.tg and get an API key.
//   2. Open their current API reference and diff it against the request/
//      response shapes below (endpoint path, field names, webhook signature
//      method). Fix anything that's drifted.
//   3. Send yourself a small real test payment end-to-end before launching.
// The Telegram Stars path in lib/telegram.js does NOT have this caveat — that
// one is the stable, documented Bot API and is fully tested in this project.

const WALLET_PAY_API_KEY = process.env.WALLET_PAY_API_KEY;
const WALLET_PAY_BASE_URL = process.env.WALLET_PAY_BASE_URL || "https://pay.wallet.tg/wpay/store-api/v1";

function assertConfigured() {
  if (!WALLET_PAY_API_KEY) {
    throw new Error(
      "WALLET_PAY_API_KEY is not set — crypto top-ups are disabled until you add it to .env (see .env.example)."
    );
  }
}

/**
 * Creates a Wallet Pay order and returns a pay link to open in Telegram.
 * @param {object} params
 * @param {string} params.orderId - your internal order id, sent back as externalId
 * @param {number} params.amountUsd - amount in USD (Wallet Pay converts to crypto at checkout)
 * @param {string} params.description
 * @param {number} params.customerTelegramUserId
 * @param {string} params.webhookUrl - where Wallet Pay should POST payment confirmations
 */
async function createOrder({ orderId, amountUsd, description, customerTelegramUserId, webhookUrl }) {
  assertConfigured();

  const res = await fetch(`${WALLET_PAY_BASE_URL}/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Wpay-Store-Api-Key": WALLET_PAY_API_KEY,
    },
    body: JSON.stringify({
      amount: { currencyCode: "USD", amount: amountUsd.toFixed(2) },
      description: description.slice(0, 100),
      externalId: orderId,
      timeoutSeconds: 900, // 15 minutes to pay
      customerTelegramUserId,
      webhookUrl,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(
      `Wallet Pay createOrder failed (${res.status}): ${data ? JSON.stringify(data) : "no response body"}`
    );
  }

  // NOTE: verify these field names against the live API response — adjust
  // if Wallet Pay's actual response uses different casing/structure.
  const payLink = data.payLink || (data.data && data.data.payLink);
  const walletOrderId = data.id || (data.data && data.data.id);
  if (!payLink) {
    throw new Error("Wallet Pay response did not include a payLink — check the API response shape.");
  }
  return { payLink, walletOrderId };
}

/**
 * Verifies a webhook request really came from Wallet Pay.
 * ⚠️ Verify this signature method against current Wallet Pay docs — this
 * implementation assumes an HMAC-SHA256 of the raw body using your API key,
 * sent in a "Wpay-Signature" header, which is a common pattern but has not
 * been confirmed against a live account.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WALLET_PAY_API_KEY || !signatureHeader) return false;
  const crypto = require("crypto");
  const expected = crypto.createHmac("sha256", WALLET_PAY_API_KEY).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (e) {
    return false; // length mismatch etc.
  }
}

module.exports = { createOrder, verifyWebhookSignature, isConfigured: () => !!WALLET_PAY_API_KEY };
