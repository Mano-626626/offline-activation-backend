// Minimal file-based storage. This is deliberately simple so the whole
// backend can run with zero external services to get started. It is NOT
// meant to scale past a small store — swap this module for a real database
// (Postgres, MongoDB, etc.) once you have real traffic. Every function here
// is async on purpose, so that swap doesn't require touching calling code.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CATALOG_PATH = path.join(DATA_DIR, "catalog.json");
const ORDERS_PATH = path.join(DATA_DIR, "orders.json");
const BALANCES_PATH = path.join(DATA_DIR, "balances.json");
const REFERRALS_PATH = path.join(DATA_DIR, "referrals.json");

// Tiny write queue per file so two near-simultaneous writes can't corrupt
// each other (Node is single-threaded, but file writes are async).
const writeQueues = new Map();
function queueWrite(filePath, task) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(filePath, next);
  return next;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`readJson failed for ${filePath}: ${e.message}`);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  return queueWrite(filePath, () => {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  });
}

// ---------------- catalog ----------------

function getCatalog() {
  return readJson(CATALOG_PATH, []);
}

function getGameById(id) {
  return getCatalog().find((g) => g.id === id) || null;
}

async function saveCatalog(catalog) {
  await writeJsonSafe(CATALOG_PATH, catalog);
  return catalog;
}

// ---------------- orders ----------------
// order shape:
// {
//   id, userId, chatId, items:[{id,title,qty,priceStars}],
//   totalStars, status: "pending" | "paid" | "failed",
//   payload, createdAt, paidAt
// }

function getOrders() {
  return readJson(ORDERS_PATH, []);
}

async function createOrder(order) {
  const orders = getOrders();
  orders.unshift(order);
  await writeJsonSafe(ORDERS_PATH, orders);
  return order;
}

async function markOrderPaid(orderId, telegramPaymentChargeId) {
  const orders = getOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return null;
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.telegramPaymentChargeId = telegramPaymentChargeId;
  await writeJsonSafe(ORDERS_PATH, orders);
  return order;
}

function getOrderById(orderId) {
  return getOrders().find((o) => o.id === orderId) || null;
}

function getOrdersForUser(userId) {
  return getOrders().filter((o) => String(o.userId) === String(userId));
}

// ---------------- balance (internal Stars-denominated wallet) ----------------
// Topping up (via Stars or crypto) credits this balance. Cart checkout now
// spends it via deductBalance() below — see server.js /api/checkout-from-balance.

function getBalances() {
  return readJson(BALANCES_PATH, {});
}

function getBalance(userId) {
  const balances = getBalances();
  return balances[String(userId)] || 0;
}

async function addBalance(userId, amountStars) {
  const balances = getBalances();
  const key = String(userId);
  balances[key] = (balances[key] || 0) + amountStars;
  await writeJsonSafe(BALANCES_PATH, balances);
  return balances[key];
}

/**
 * Spends from a user's balance. Returns the new balance, or null if the
 * user doesn't have enough (nothing is deducted in that case).
 */
async function deductBalance(userId, amountStars) {
  const balances = getBalances();
  const key = String(userId);
  const current = balances[key] || 0;
  if (current < amountStars) return null;
  balances[key] = current - amountStars;
  await writeJsonSafe(BALANCES_PATH, balances);
  return balances[key];
}

// ---------------- referrals ----------------
// { codes: { "AB12CD": userId }, byUser: { userId: {code,invited,converted,earnedStars} },
//   relations: { referredUserId: {referrerId, rewarded} } }

function getReferralData() {
  return readJson(REFERRALS_PATH, { codes: {}, byUser: {}, relations: {} });
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/** Every user gets one persistent random code, created the first time it's needed. */
async function getOrCreateReferralCode(userId) {
  const data = getReferralData();
  const key = String(userId);
  if (data.byUser[key]) return data.byUser[key].code;

  let code = randomCode();
  while (data.codes[code]) code = randomCode(); // vanishingly rare, but be safe
  data.codes[code] = key;
  data.byUser[key] = { code, invited: 0, converted: 0, earnedStars: 0 };
  await writeJsonSafe(REFERRALS_PATH, data);
  return code;
}

function getReferralStats(userId) {
  const data = getReferralData();
  return data.byUser[String(userId)] || { code: null, invited: 0, converted: 0, earnedStars: 0 };
}

/** Called when a NEW user opens the app via someone's referral link. */
async function registerReferral(referredUserId, code) {
  const data = getReferralData();
  const referrerId = data.codes[code];
  const referredKey = String(referredUserId);
  if (!referrerId) return { ok: false, error: "Unknown referral code" };
  if (String(referrerId) === referredKey) return { ok: false, error: "Can't refer yourself" };
  if (data.relations[referredKey]) return { ok: false, error: "Already referred" };

  data.relations[referredKey] = { referrerId, rewarded: false };
  if (!data.byUser[referrerId]) data.byUser[referrerId] = { code: null, invited: 0, converted: 0, earnedStars: 0 };
  data.byUser[referrerId].invited += 1;
  await writeJsonSafe(REFERRALS_PATH, data);
  return { ok: true };
}

/**
 * Called after a referred user's first successful game purchase. Credits the
 * referrer's balance once, the first time only (never twice for the same
 * referred user).
 */
async function rewardReferralIfEligible(referredUserId, rewardStars) {
  const data = getReferralData();
  const referredKey = String(referredUserId);
  const relation = data.relations[referredKey];
  if (!relation || relation.rewarded) return null;

  relation.rewarded = true;
  const referrerKey = String(relation.referrerId);
  if (!data.byUser[referrerKey]) data.byUser[referrerKey] = { code: null, invited: 0, converted: 0, earnedStars: 0 };
  data.byUser[referrerKey].converted += 1;
  data.byUser[referrerKey].earnedStars += rewardStars;
  await writeJsonSafe(REFERRALS_PATH, data);

  await addBalance(relation.referrerId, rewardStars);
  return { referrerId: relation.referrerId, rewardStars };
}

module.exports = {
  getCatalog,
  getGameById,
  saveCatalog,
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
