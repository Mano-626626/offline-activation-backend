// Verifies Telegram Mini App `initData` server-side so we never trust the
// client's word for who a user is. This follows Telegram's documented
// algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Without this, anyone could send a fake user id to /api/create-invoice and
// order things as somebody else, or spoof being an admin.

const crypto = require('crypto');

/**
 * @param {string} initData - the raw initData string from Telegram.WebApp.initData
 * @param {string} botToken - your bot's token (from .env, never from the client)
 * @param {number} [maxAgeSeconds=86400] - reject data older than this (default 24h)
 * @returns {{ok:true, user:object} | {ok:false, error:string}}
 */
function verifyInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== "string") {
    return { ok: false, error: "missing initData" };
  }
  if (!botToken) {
    return { ok: false, error: "server misconfigured: BOT_TOKEN not set" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "initData missing hash" };
  params.delete("hash");

  // Build the data-check-string: all fields except hash, sorted alphabetically,
  // joined as "key=value" with newlines.
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  // secret_key = HMAC_SHA256(bot_token, key="WebAppData")
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { ok: false, error: "invalid signature" };
  }

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) {
    return { ok: false, error: "initData expired" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    return { ok: false, error: "invalid user payload" };
  }
  if (!user || !user.id) {
    return { ok: false, error: "no user in initData" };
  }

  return { ok: true, user };
}

module.exports = { verifyInitData };
