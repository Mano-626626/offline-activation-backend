const WALLET_PAY_API_KEY = process.env.WALLET_PAY_API_KEY;
const WALLET_PAY_BASE_URL = process.env.WALLET_PAY_BASE_URL || "https://pay.wallet.tg/wpay/store-api/v1";

function assertConfigured() {
  if (!WALLET_PAY_API_KEY) {
    throw new Error(
      "WALLET_PAY_API_KEY is not set — crypto top-ups are disabled until you add it to .env (see .env.example)."
    );
  }
}

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
      timeoutSeconds: 900,
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

  const payLink = data.payLink || (data.data && data.data.payLink);
  const walletOrderId = data.id || (data.data && data.data.id);
  if (!payLink) {
    throw new Error("Wallet Pay response did not include a payLink — check the API response shape.");
  }
  return { payLink, walletOrderId };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WALLET_PAY_API_KEY || !signatureHeader) return false;
  const crypto = require("crypto");
  const expected = crypto.createHmac("sha256", WALLET_PAY_API_KEY).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (e) {
    return false;
  }
}

module.exports = { createOrder, verifyWebhookSignature, isConfigured: () => !!WALLET_PAY_API_KEY };
