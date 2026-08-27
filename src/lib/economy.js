const DEFAULTS = {
  currency_name: 'コイン',
  currency_emoji: '🪙',
  starting_balance: 100,
  min_bet: 1,
  max_bet: 1000,
};

/** サーバーごとの通貨設定（無ければ既定値で作る）。 */
export async function getSettings(db, guildId) {
  const existing = await db.get('SELECT * FROM guild_settings WHERE guild_id = ?1', guildId);
  if (existing) return existing;
  await db.run(
    `INSERT OR IGNORE INTO guild_settings (guild_id, currency_name, currency_emoji, starting_balance, min_bet, max_bet)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    guildId,
    DEFAULTS.currency_name,
    DEFAULTS.currency_emoji,
    DEFAULTS.starting_balance,
    DEFAULTS.min_bet,
    DEFAULTS.max_bet,
  );
  return db.get('SELECT * FROM guild_settings WHERE guild_id = ?1', guildId);
}

export async function updateSettings(db, guildId, patch) {
  await getSettings(db, guildId);
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined && patch[key] !== null);
  if (keys.length > 0) {
    const assignments = keys.map((key, index) => `${key} = ?${index + 2}`).join(', ');
    await db.run(`UPDATE guild_settings SET ${assignments} WHERE guild_id = ?1`, guildId, ...keys.map((k) => patch[k]));
  }
  return getSettings(db, guildId);
}

/** 口座が無ければ初期残高で作る。 */
export async function ensureAccount(db, guildId, userId) {
  const settings = await getSettings(db, guildId);
  const created = await db.run(
    'INSERT OR IGNORE INTO balances (guild_id, user_id, balance) VALUES (?1, ?2, ?3)',
    guildId,
    userId,
    settings.starting_balance,
  );
  if (created.changes === 1 && settings.starting_balance !== 0) {
    await writeLedger(db, guildId, userId, settings.starting_balance, 'initial', '初期残高');
  }
}

export async function getBalance(db, guildId, userId) {
  await ensureAccount(db, guildId, userId);
  const row = await db.get('SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  return row?.balance ?? 0;
}

function ledgerStatement(guildId, userId, amount, reason, detail) {
  return [
    'INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    guildId,
    userId,
    amount,
    reason,
    detail ?? null,
    Date.now(),
  ];
}

async function writeLedger(db, guildId, userId, amount, reason, detail = null) {
  await db.run(...ledgerStatement(guildId, userId, amount, reason, detail));
}

/** 残高を増やす。 */
export async function deposit(db, guildId, userId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('deposit の金額は正の整数である必要があります');
  await ensureAccount(db, guildId, userId);
  await db.batch([
    ['UPDATE balances SET balance = balance + ?3 WHERE guild_id = ?1 AND user_id = ?2', guildId, userId, amount],
    ledgerStatement(guildId, userId, amount, reason, detail),
  ]);
  return getBalance(db, guildId, userId);
}

/**
 * 残高を減らす。残高不足なら何もせず false。
 * 条件付き UPDATE ひとつで判定するので、同時に押されてもマイナスにならない。
 */
export async function withdraw(db, guildId, userId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('withdraw の金額は正の整数である必要があります');
  await ensureAccount(db, guildId, userId);
  const result = await db.run(
    'UPDATE balances SET balance = balance - ?3 WHERE guild_id = ?1 AND user_id = ?2 AND balance >= ?3',
    guildId,
    userId,
    amount,
  );
  if (result.changes !== 1) return false;
  await writeLedger(db, guildId, userId, -amount, reason, detail);
  return true;
}

/** 管理者操作。0未満にはしない。 */
export async function adjust(db, guildId, userId, delta, reason, detail = null) {
  await ensureAccount(db, guildId, userId);
  await db.batch([
    ['UPDATE balances SET balance = MAX(0, balance + ?3) WHERE guild_id = ?1 AND user_id = ?2', guildId, userId, delta],
    ledgerStatement(guildId, userId, delta, reason, detail),
  ]);
  return getBalance(db, guildId, userId);
}

export async function setBalance(db, guildId, userId, value, reason, detail = null) {
  const before = await getBalance(db, guildId, userId);
  return adjust(db, guildId, userId, value - before, reason, detail);
}

/**
 * 送金。差し引きと足し込みを1文で行うので、途中で片方だけ成立することがない。
 * @returns {Promise<boolean>} 残高不足なら false
 */
export async function transfer(db, guildId, fromId, toId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  await ensureAccount(db, guildId, fromId);
  await ensureAccount(db, guildId, toId);

  const moved = await db.run(
    `UPDATE balances
        SET balance = balance + CASE user_id WHEN ?2 THEN -?4 ELSE ?4 END
      WHERE guild_id = ?1
        AND user_id IN (?2, ?3)
        AND (SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2) >= ?4`,
    guildId,
    fromId,
    toId,
    amount,
  );
  if (moved.changes !== 2) return false;

  await db.batch([
    ledgerStatement(guildId, fromId, -amount, reason, detail),
    ledgerStatement(guildId, toId, amount, reason, detail),
  ]);
  return true;
}

export async function topBalances(db, guildId, limit = 10) {
  return db.all(
    'SELECT user_id, balance FROM balances WHERE guild_id = ?1 ORDER BY balance DESC, user_id ASC LIMIT ?2',
    guildId,
    limit,
  );
}

export async function rankOf(db, guildId, userId) {
  const row = await db.get(
    `SELECT COUNT(*) + 1 AS rank FROM balances
      WHERE guild_id = ?1 AND balance > (SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2)`,
    guildId,
    userId,
  );
  return row?.rank ?? 1;
}

export async function ledgerFor(db, guildId, userId, limit = 15) {
  return db.all('SELECT * FROM ledger WHERE guild_id = ?1 AND user_id = ?2 ORDER BY id DESC LIMIT ?3', guildId, userId, limit);
}

export async function totals(db, guildId, userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS earned,
            COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS spent
       FROM ledger WHERE guild_id = ?1 AND user_id = ?2`,
    guildId,
    userId,
  );
  return { earned: row?.earned ?? 0, spent: row?.spent ?? 0 };
}
