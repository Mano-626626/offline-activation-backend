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
// Topping up (via Stars or crypto) credits this balance. Spending it against
// a purchase is NOT wired up yet in this build — see server.js comments for
// where that would plug in when you're ready to let people check out using
// their balance instead of paying per-order.

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

module.exports = {
  getCatalog,
  getGameById,
  getOrders,
  createOrder,
  markOrderPaid,
  getOrderById,
  getOrdersForUser,
  getBalance,
  addBalance,
};
