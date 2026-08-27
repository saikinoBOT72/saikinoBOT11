import { getDb } from './db.js';

const DEFAULT_SETTINGS = {
  currency_name: 'コイン',
  currency_emoji: '🪙',
  starting_balance: 100,
  min_bet: 1,
  max_bet: 1000,
};

/** サーバーごとの通貨設定を取得する（無ければ既定値で作成）。 */
export function getSettings(guildId) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!row) {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, currency_name, currency_emoji, starting_balance, min_bet, max_bet)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      DEFAULT_SETTINGS.currency_name,
      DEFAULT_SETTINGS.currency_emoji,
      DEFAULT_SETTINGS.starting_balance,
      DEFAULT_SETTINGS.min_bet,
      DEFAULT_SETTINGS.max_bet,
    );
    row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  }
  return row;
}

export function updateSettings(guildId, patch) {
  getSettings(guildId);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && patch[k] !== null);
  if (keys.length === 0) return getSettings(guildId);
  const sql = `UPDATE guild_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`;
  getDb().prepare(sql).run(...keys.map((k) => patch[k]), guildId);
  return getSettings(guildId);
}

/** 口座が無ければ初期残高で作る。 */
export function ensureAccount(guildId, userId) {
  const db = getDb();
  const existing = db.prepare('SELECT balance FROM balances WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (existing) return existing.balance;
  const settings = getSettings(guildId);
  const start = settings.starting_balance;
  db.prepare('INSERT INTO balances (guild_id, user_id, balance) VALUES (?, ?, ?)').run(guildId, userId, start);
  if (start !== 0) recordLedger(guildId, userId, start, 'initial', '初期残高');
  return start;
}

export function getBalance(guildId, userId) {
  return ensureAccount(guildId, userId);
}

function recordLedger(guildId, userId, amount, reason, detail = null) {
  getDb()
    .prepare('INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, amount, reason, detail, Date.now());
}

/** 残高を増やす（amount は正の整数）。 */
export function deposit(guildId, userId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('deposit の金額は正の整数である必要があります');
  const db = getDb();
  ensureAccount(guildId, userId);
  const run = db.transaction(() => {
    db.prepare('UPDATE balances SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, guildId, userId);
    recordLedger(guildId, userId, amount, reason, detail);
  });
  run();
  return getBalance(guildId, userId);
}

/**
 * 残高を減らす。残高不足なら何もせず false を返す（同時実行でもマイナスにならない）。
 */
export function withdraw(guildId, userId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('withdraw の金額は正の整数である必要があります');
  const db = getDb();
  ensureAccount(guildId, userId);
  const run = db.transaction(() => {
    const res = db
      .prepare('UPDATE balances SET balance = balance - ? WHERE guild_id = ? AND user_id = ? AND balance >= ?')
      .run(amount, guildId, userId, amount);
    if (res.changes !== 1) return false;
    recordLedger(guildId, userId, -amount, reason, detail);
    return true;
  });
  return run();
}

/** 管理者操作用。マイナスも許容して残高を直接動かす。 */
export function adjust(guildId, userId, delta, reason, detail = null) {
  const db = getDb();
  ensureAccount(guildId, userId);
  const run = db.transaction(() => {
    db.prepare('UPDATE balances SET balance = MAX(0, balance + ?) WHERE guild_id = ? AND user_id = ?').run(delta, guildId, userId);
    recordLedger(guildId, userId, delta, reason, detail);
  });
  run();
  return getBalance(guildId, userId);
}

export function setBalance(guildId, userId, value, reason, detail = null) {
  const before = getBalance(guildId, userId);
  return adjust(guildId, userId, value - before, reason, detail);
}

/** ユーザー間送金。残高不足なら false。 */
export function transfer(guildId, fromId, toId, amount, reason, detail = null) {
  const db = getDb();
  ensureAccount(guildId, fromId);
  ensureAccount(guildId, toId);
  const run = db.transaction(() => {
    const res = db
      .prepare('UPDATE balances SET balance = balance - ? WHERE guild_id = ? AND user_id = ? AND balance >= ?')
      .run(amount, guildId, fromId, amount);
    if (res.changes !== 1) return false;
    db.prepare('UPDATE balances SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, guildId, toId);
    recordLedger(guildId, fromId, -amount, reason, detail);
    recordLedger(guildId, toId, amount, reason, detail);
    return true;
  });
  return run();
}

export function topBalances(guildId, limit = 10) {
  return getDb()
    .prepare('SELECT user_id, balance FROM balances WHERE guild_id = ? ORDER BY balance DESC, user_id ASC LIMIT ?')
    .all(guildId, limit);
}

export function rankOf(guildId, userId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM balances
       WHERE guild_id = ? AND balance > (SELECT balance FROM balances WHERE guild_id = ? AND user_id = ?)`,
    )
    .get(guildId, guildId, userId);
  return row?.rank ?? 1;
}
