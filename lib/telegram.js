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

async function createInvoiceLink({ title, description, payload, prices }) {
  return callTelegram("createInvoiceLink", {
    title,
    description,
    payload,
    currency: "XTR",
    prices,
  });
}

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
