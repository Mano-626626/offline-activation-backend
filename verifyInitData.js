// Thin wrapper around the Telegram Bot API. Every call here uses BOT_TOKEN
// from process.env — it is read once at call time so .env can be reloaded
// in dev without restarting, and it is NEVER sent to the client.

const BOT_TOKEN = process.env.BOT_TOKEN;

function apiUrl(method) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not set. Create a .env file — see .env.example.");
  }
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function callTelegram(method, payload) {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || JSON.stringify(data)}`);
  }
  return data.result;
}

/**
 * Creates a Telegram Stars invoice link.
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.description
 * @param {string} params.payload - internal order id, echoed back on successful_payment (max 128 bytes)
 * @param {Array<{label:string, amount:number}>} params.prices - amounts in Stars (integers)
 * @returns {Promise<string>} the invoice link to pass to Telegram.WebApp.openInvoice()
 */
async function createInvoiceLink({ title, description, payload, prices }) {
  return callTelegram("createInvoiceLink", {
    title,
    description,
    payload,
    // provider_token is intentionally omitted — Telegram Stars payments (currency XTR)
    // don't use a payment provider, Telegram itself settles them.
    currency: "XTR",
    prices,
  });
}

/** Must be answered within 10 seconds of receiving a pre_checkout_query update. */
async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  return callTelegram("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function setWebhook(url, secretToken) {
  return callTelegram("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["pre_checkout_query", "message"],
  });
}

async function deleteWebhook() {
  return callTelegram("deleteWebhook", {});
}

async function getWebhookInfo() {
  return callTelegram("getWebhookInfo", {});
}

module.exports = {
  createInvoiceLink,
  answerPreCheckoutQuery,
  sendMessage,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
};
