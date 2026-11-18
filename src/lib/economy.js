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

const BALANCE_OF = 'SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2';

/**
 * 口座が無ければ初期残高で作る。
 * ほとんどの場合はもう口座があるので、まず1回読むだけで済ませる
 * （毎回「設定を読む→作ろうとする」をやると、画面を1つ出すたびに往復が増える）。
 */
export async function ensureAccount(db, guildId, userId) {
  if (await db.get(BALANCE_OF, guildId, userId)) return;

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
  const row = await db.get(BALANCE_OF, guildId, userId);
  if (row) return row.balance;
  await ensureAccount(db, guildId, userId);
  return (await db.get(BALANCE_OF, guildId, userId))?.balance ?? 0;
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
 * 「残高が足りている」という条件。?1=サーバー ?2=本人 ?3=必要な額。
 *
 * 履歴の記録と引き落としを1つの処理（トランザクション）にまとめるとき、
 * すべての文にこの同じ条件を付け、引き落としを最後に置く。
 * 引き落とすまで残高は変わらないので、条件の真偽が途中で変わらない。
 * 「引き落とせたのに履歴が無い」「履歴だけ残った」が起きなくなる。
 */
const CAN_PAY = `(${BALANCE_OF}) >= ?3`;

const LEDGER_COLUMNS = 'INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)';

/**
 * 残高を減らす。残高不足なら何もせず false。
 * 条件付きの文だけで判定するので、同時に押されてもマイナスにならない。
 */
export async function withdraw(db, guildId, userId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('withdraw の金額は正の整数である必要があります');
  await ensureAccount(db, guildId, userId);
  const results = await db.batch([
    [`${LEDGER_COLUMNS} SELECT ?1, ?2, -?3, ?4, ?5, ?6 WHERE ${CAN_PAY}`, guildId, userId, amount, reason, detail ?? null, Date.now()],
    ['UPDATE balances SET balance = balance - ?3 WHERE guild_id = ?1 AND user_id = ?2 AND balance >= ?3', guildId, userId, amount],
  ]);
  return results.at(-1).changes === 1;
}

/**
 * 賭けて、その場で結果が出るゲーム用（スロット・コイントスなど）。
 *
 * 「賭け金を引く」と「当たりを足す」を別々にやると、あいだで処理が落ちたときに
 * 賭け金だけが消える。結果は先に決めておき、出入りを1回の処理で済ませる。
 * @param {any} db
 * @param {string} guildId
 * @param {string} userId
 * @param {{bet: number, payout: number, betReason: string, winReason: string, detail?: string|null}} wager
 * @returns {Promise<{ok: boolean, balance: number}>} 残高不足なら ok が false（何も動かない）
 */
export async function settleWager(db, guildId, userId, { bet, payout, betReason, winReason, detail = null }) {
  if (!Number.isInteger(bet) || bet <= 0) throw new Error('settleWager の賭け金は正の整数である必要があります');
  if (!Number.isInteger(payout) || payout < 0) throw new Error('settleWager の払い戻しは0以上の整数である必要があります');
  await ensureAccount(db, guildId, userId);

  const now = Date.now();
  const statements = [[`${LEDGER_COLUMNS} SELECT ?1, ?2, -?3, ?4, NULL, ?5 WHERE ${CAN_PAY}`, guildId, userId, bet, betReason, now]];
  if (payout > 0) {
    statements.push([
      `${LEDGER_COLUMNS} SELECT ?1, ?2, ?4, ?5, ?6, ?7 WHERE ${CAN_PAY}`,
      guildId, userId, bet, payout, winReason, detail ?? null, now,
    ]);
  }
  statements.push([
    'UPDATE balances SET balance = balance - ?3 + ?4 WHERE guild_id = ?1 AND user_id = ?2 AND balance >= ?3',
    guildId, userId, bet, payout,
  ]);

  const results = await db.batch(statements);
  return { ok: results.at(-1).changes === 1, balance: await getBalance(db, guildId, userId) };
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
 * 送金。差し引き・足し込み・履歴を1つの処理で行うので、途中で片方だけ成立することがない。
 * @returns {Promise<boolean>} 残高不足なら false
 */
export async function transfer(db, guildId, fromId, toId, amount, reason, detail = null) {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  await ensureAccount(db, guildId, fromId);
  await ensureAccount(db, guildId, toId);

  // 履歴2行と残高の移動を1つの処理にまとめる（withdraw と同じ考え方）
  const now = Date.now();
  const results = await db.batch([
    [`${LEDGER_COLUMNS} SELECT ?1, ?2, -?3, ?4, ?5, ?6 WHERE ${CAN_PAY}`, guildId, fromId, amount, reason, detail ?? null, now],
    [`${LEDGER_COLUMNS} SELECT ?1, ?4, ?3, ?5, ?6, ?7 WHERE ${CAN_PAY}`, guildId, fromId, amount, toId, reason, detail ?? null, now],
    [
      `UPDATE balances
          SET balance = balance + CASE user_id WHEN ?2 THEN -?4 ELSE ?4 END
        WHERE guild_id = ?1
          AND user_id IN (?2, ?3)
          AND (SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2) >= ?4`,
      guildId, fromId, toId, amount,
    ],
  ]);
  return results.at(-1).changes === 2;
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
