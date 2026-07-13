// Real, persistent database via Postgres (works great with Supabase's free
// tier). This replaces the old JSON-file storage — same idea, same exported
// function names, but now nothing is lost when the server restarts.
//
// Needs DATABASE_URL in .env — the connection string from your Postgres
// provider (see backend/README.md for how to get one from Supabase).

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL; this trusts their cert chain
  max: 3, // fewer simultaneous connections = less memory on a tight 512MB instance
  idleTimeoutMillis: 10000, // close idle connections quickly instead of holding them open
});

// CRITICAL: without this, a transient network hiccup on an idle connection
// (which happens occasionally with any hosted database) fires an 'error'
// event on the pool. In Node.js, an EventEmitter's unhandled 'error' event
// throws and crashes the ENTIRE process — not just that one request. That
// would explain intermittent 502s and any in-progress save being lost. This
// handler logs the problem instead of letting it take the whole server down.
pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client (server stays up):", err.message);
});

// Creates the tables if they don't exist yet. Safe to run every time the
// server starts — CREATE TABLE IF NOT EXISTS is a no-op once they exist.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      price_usd NUMERIC NOT NULL,
      price_stars INTEGER NOT NULL,
      description TEXT DEFAULT '',
      rating NUMERIC DEFAULT 4.5,
      image_url TEXT,
      steam_login TEXT DEFAULT 'REPLACE_ME',
      steam_password TEXT DEFAULT 'REPLACE_ME',
      delivery_note TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      username TEXT,
      items JSONB NOT NULL,
      total_stars INTEGER NOT NULL,
      status TEXT NOT NULL,
      type TEXT,
      method TEXT,
      paid_via TEXT,
      amount_usd NUMERIC,
      telegram_payment_charge_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS balances (
      user_id TEXT PRIMARY KEY,
      balance_stars INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS referral_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS referral_stats (
      user_id TEXT PRIMARY KEY,
      invited INTEGER NOT NULL DEFAULT 0,
      converted INTEGER NOT NULL DEFAULT 0,
      earned_stars INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS referral_relations (
      referred_user_id TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      rewarded BOOLEAN NOT NULL DEFAULT false
    );
  `);
}
// Kick off schema setup immediately; every exported function below awaits
// this first so callers never race against table creation.
const schemaReady = ensureSchema().catch((e) => {
  console.error("Failed to set up database schema:", e.message);
});

function gameRowToObject(row) {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    priceUsd: Number(row.price_usd),
    priceStars: row.price_stars,
    desc: row.description,
    rating: Number(row.rating),
    imageUrl: row.image_url,
    delivery: {
      steamLogin: row.steam_login,
      steamPassword: row.steam_password,
      note: row.delivery_note,
    },
  };
}

// ---------------- catalog ----------------

async function getCatalog() {
  await schemaReady;
  const { rows } = await pool.query("SELECT * FROM games ORDER BY id");
  return rows.map(gameRowToObject);
}

async function getGameById(id) {
  await schemaReady;
  const { rows } = await pool.query("SELECT * FROM games WHERE id = $1", [id]);
  return rows.length ? gameRowToObject(rows[0]) : null;
}

async function saveCatalog(catalog) {
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM games");
    for (const g of catalog) {
      await client.query(
        `INSERT INTO games (id, title, genre, price_usd, price_stars, description, rating, image_url, steam_login, steam_password, delivery_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          g.id, g.title, g.genre, g.priceUsd, g.priceStars, g.desc || "", g.rating || 4.5,
          g.imageUrl || null,
          (g.delivery && g.delivery.steamLogin) || "REPLACE_ME",
          (g.delivery && g.delivery.steamPassword) || "REPLACE_ME",
          (g.delivery && g.delivery.note) || "",
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return catalog;
}

async function insertGame(g) {
  await schemaReady;
  await pool.query(
    `INSERT INTO games (id, title, genre, price_usd, price_stars, description, rating, image_url, steam_login, steam_password, delivery_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      g.id, g.title, g.genre, g.priceUsd, g.priceStars, g.desc || "", g.rating || 4.5,
      g.imageUrl || null, "REPLACE_ME", "REPLACE_ME",
      "Log into this Steam account, install the game, then switch Steam to Offline Mode.",
    ]
  );
  return getGameById(g.id);
}

async function updateGame(id, fields) {
  await schemaReady;
  const sets = [];
  const values = [];
  let i = 1;
  if (fields.title !== undefined) { sets.push(`title = $${i++}`); values.push(fields.title); }
  if (fields.genre !== undefined) { sets.push(`genre = $${i++}`); values.push(fields.genre); }
  if (fields.priceUsd !== undefined) { sets.push(`price_usd = $${i++}`); values.push(fields.priceUsd); }
  if (fields.priceStars !== undefined) { sets.push(`price_stars = $${i++}`); values.push(fields.priceStars); }
  if (fields.desc !== undefined) { sets.push(`description = $${i++}`); values.push(fields.desc); }
  if (fields.imageUrl !== undefined) { sets.push(`image_url = $${i++}`); values.push(fields.imageUrl); }
  if (!sets.length) return getGameById(id);
  values.push(id);
  await pool.query(`UPDATE games SET ${sets.join(", ")} WHERE id = $${i}`, values);
  return getGameById(id);
}

async function deleteGame(id) {
  await schemaReady;
  await pool.query("DELETE FROM games WHERE id = $1", [id]);
}

// ---------------- orders ----------------

function orderRowToObject(row) {
  return {
    id: row.id,
    userId: row.user_id,
    chatId: row.chat_id,
    username: row.username,
    items: row.items,
    totalStars: row.total_stars,
    status: row.status,
    type: row.type,
    method: row.method,
    paidVia: row.paid_via,
    amountUsd: row.amount_usd !== null ? Number(row.amount_usd) : undefined,
    telegramPaymentChargeId: row.telegram_payment_charge_id,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

async function createOrder(order) {
  await schemaReady;
  await pool.query(
    `INSERT INTO orders (id, user_id, chat_id, username, items, total_stars, status, type, method, paid_via, amount_usd, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
    [
      order.id, String(order.userId), String(order.chatId), order.username || null,
      JSON.stringify(order.items || []), order.totalStars, order.status,
      order.type || null, order.method || null, order.paidVia || null,
      order.amountUsd !== undefined ? order.amountUsd : null,
    ]
  );
  return order;
}

async function markOrderPaid(orderId, telegramPaymentChargeId) {
  await schemaReady;
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'paid', paid_at = now(), telegram_payment_charge_id = $2
     WHERE id = $1 RETURNING *`,
    [orderId, telegramPaymentChargeId]
  );
  return rows.length ? orderRowToObject(rows[0]) : null;
}

async function getOrderById(orderId) {
  await schemaReady;
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  return rows.length ? orderRowToObject(rows[0]) : null;
}

async function getOrdersForUser(userId) {
  await schemaReady;
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC",
    [String(userId)]
  );
  return rows.map(orderRowToObject);
}

async function getOrders() {
  await schemaReady;
  const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
  return rows.map(orderRowToObject);
}

// ---------------- balance ----------------

async function getBalance(userId) {
  await schemaReady;
  const { rows } = await pool.query("SELECT balance_stars FROM balances WHERE user_id = $1", [String(userId)]);
  return rows.length ? rows[0].balance_stars : 0;
}

async function addBalance(userId, amountStars) {
  await schemaReady;
  const { rows } = await pool.query(
    `INSERT INTO balances (user_id, balance_stars) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance_stars = balances.balance_stars + $2
     RETURNING balance_stars`,
    [String(userId), amountStars]
  );
  return rows[0].balance_stars;
}

async function deductBalance(userId, amountStars) {
  await schemaReady;
  const { rows } = await pool.query(
    `UPDATE balances SET balance_stars = balance_stars - $2
     WHERE user_id = $1 AND balance_stars >= $2
     RETURNING balance_stars`,
    [String(userId), amountStars]
  );
  return rows.length ? rows[0].balance_stars : null;
}

// ---------------- referrals ----------------

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getOrCreateReferralCode(userId) {
  await schemaReady;
  const key = String(userId);
  const existing = await pool.query("SELECT code FROM referral_codes WHERE user_id = $1", [key]);
  if (existing.rows.length) return existing.rows[0].code;

  let code = randomCode();
  for (let attempts = 0; attempts < 10; attempts++) {
    try {
      await pool.query("INSERT INTO referral_codes (code, user_id) VALUES ($1, $2)", [code, key]);
      await pool.query(
        `INSERT INTO referral_stats (user_id, invited, converted, earned_stars) VALUES ($1, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [key]
      );
      return code;
    } catch (e) {
      if (e.code === "23505") { code = randomCode(); continue; }
      throw e;
    }
  }
  throw new Error("Could not generate a unique referral code");
}

async function getReferralStats(userId) {
  await schemaReady;
  const key = String(userId);
  const codeRow = await pool.query("SELECT code FROM referral_codes WHERE user_id = $1", [key]);
  const statsRow = await pool.query("SELECT invited, converted, earned_stars FROM referral_stats WHERE user_id = $1", [key]);
  const stats = statsRow.rows[0] || { invited: 0, converted: 0, earned_stars: 0 };
  return {
    code: codeRow.rows.length ? codeRow.rows[0].code : null,
    invited: stats.invited,
    converted: stats.converted,
    earnedStars: stats.earned_stars,
  };
}

async function registerReferral(referredUserId, code) {
  await schemaReady;
  const referredKey = String(referredUserId);
  const codeRow = await pool.query("SELECT user_id FROM referral_codes WHERE code = $1", [code]);
  if (!codeRow.rows.length) return { ok: false, error: "Unknown referral code" };
  const referrerId = codeRow.rows[0].user_id;
  if (referrerId === referredKey) return { ok: false, error: "Can't refer yourself" };

  const existing = await pool.query("SELECT 1 FROM referral_relations WHERE referred_user_id = $1", [referredKey]);
  if (existing.rows.length) return { ok: false, error: "Already referred" };

  await pool.query(
    "INSERT INTO referral_relations (referred_user_id, referrer_id, rewarded) VALUES ($1, $2, false)",
    [referredKey, referrerId]
  );
  await pool.query(
    `INSERT INTO referral_stats (user_id, invited, converted, earned_stars) VALUES ($1, 1, 0, 0)
     ON CONFLICT (user_id) DO UPDATE SET invited = referral_stats.invited + 1`,
    [referrerId]
  );
  return { ok: true };
}

async function rewardReferralIfEligible(referredUserId, rewardStars) {
  await schemaReady;
  const referredKey = String(referredUserId);
  const relation = await pool.query(
    "SELECT referrer_id, rewarded FROM referral_relations WHERE referred_user_id = $1",
    [referredKey]
  );
  if (!relation.rows.length || relation.rows[0].rewarded) return null;
  const referrerId = relation.rows[0].referrer_id;

  await pool.query("UPDATE referral_relations SET rewarded = true WHERE referred_user_id = $1", [referredKey]);
  await pool.query(
    `INSERT INTO referral_stats (user_id, invited, converted, earned_stars) VALUES ($1, 0, 1, $2)
     ON CONFLICT (user_id) DO UPDATE SET converted = referral_stats.converted + 1, earned_stars = referral_stats.earned_stars + $2`,
    [referrerId, rewardStars]
  );
  await addBalance(referrerId, rewardStars);
  return { referrerId, rewardStars };
}

module.exports = {
  getCatalog,
  getGameById,
  saveCatalog,
  insertGame,
  updateGame,
  deleteGame,
  getOrders,
  createOrder,
  markOrderPaid,
  getOrderById,
  getOrdersForUser,
  getBalance,
  addBalance,
  deductBalance,
  getOrCreateReferralCode,
  getReferralStats,
  registerReferral,
  rewardReferralIfEligible,
};

