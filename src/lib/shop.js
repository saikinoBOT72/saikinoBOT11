import { ensureAccount, getBalance } from './economy.js';

export class ShopError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function createItem(db, { guildId, sellerId, name, description, price, imageUrl, stock }) {
  const result = await db.run(
    `INSERT INTO shop_items (guild_id, seller_id, name, description, price, image_url, stock, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    guildId,
    sellerId,
    name,
    description ?? null,
    price,
    imageUrl ?? null,
    stock,
    Date.now(),
  );
  return getItem(db, guildId, result.lastRowId);
}

export async function getItem(db, guildId, id) {
  return db.get('SELECT * FROM shop_items WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function listItems(db, guildId, { includeInactive = false, sellerId = null, limit = 25, offset = 0 } = {}) {
  if (sellerId) {
    const activeClause = includeInactive ? '' : ' AND active = 1';
    return db.all(
      `SELECT * FROM shop_items WHERE guild_id = ?1 AND seller_id = ?2${activeClause} ORDER BY created_at DESC LIMIT ?3 OFFSET ?4`,
      guildId,
      sellerId,
      limit,
      offset,
    );
  }
  const activeClause = includeInactive ? '' : ' AND active = 1';
  return db.all(
    `SELECT * FROM shop_items WHERE guild_id = ?1${activeClause} ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
    guildId,
    limit,
    offset,
  );
}

export async function countItems(db, guildId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM shop_items WHERE guild_id = ?1 AND active = 1', guildId);
  return row?.n ?? 0;
}

/** patch に入れたキーだけ更新する（null を渡せば NULL になる）。 */
export async function updateItem(db, guildId, id, patch) {
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  if (keys.length > 0) {
    const assignments = keys.map((key, index) => `${key} = ?${index + 3}`).join(', ');
    await db.run(
      `UPDATE shop_items SET ${assignments} WHERE guild_id = ?1 AND id = ?2`,
      guildId,
      id,
      ...keys.map((key) => patch[key]),
    );
  }
  return getItem(db, guildId, id);
}

export async function setActive(db, guildId, id, active) {
  await db.run('UPDATE shop_items SET active = ?3 WHERE guild_id = ?1 AND id = ?2', guildId, id, active ? 1 : 0);
  return getItem(db, guildId, id);
}

// 支払いに関わる全ての文へ同じ「残高が足りている」条件を付け、
// 引き落としを最後に置く。こうするとトランザクション内で条件の真偽が変わらないので、
// 途中まで成立して壊れる状態にならない（?1=サーバー ?2=買い手 ?3=価格）。
const PAY_GUARD = '(SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2) >= ?3';

/**
 * 購入する。
 * 「在庫を1つ確保 → 支払い → 失敗したら在庫を戻す」の順で処理するので、
 * 売り切れ・残高不足のどちらでも中途半端な状態が残らない。
 * @throws {ShopError}
 */
export async function purchase(db, guildId, itemId, buyerId) {
  const item = await getItem(db, guildId, itemId);
  if (!item) throw new ShopError('not_found', 'その商品は見つかりませんでした。');
  if (!item.active) throw new ShopError('inactive', 'その商品は現在販売されていません。');
  if (item.seller_id === buyerId) throw new ShopError('own_item', '自分の出品は購入できません。');
  if (item.stock === 0) throw new ShopError('sold_out', 'その商品は売り切れです。');

  await ensureAccount(db, guildId, buyerId);
  await ensureAccount(db, guildId, item.seller_id);

  // 1. 在庫をひとつ確保する（最後の1つなら販売停止にする）
  const reserved = await db.run(
    `UPDATE shop_items
        SET stock = CASE WHEN stock > 0 THEN stock - 1 ELSE stock END,
            sold = sold + 1,
            active = CASE WHEN stock = 1 THEN 0 ELSE active END
      WHERE id = ?2 AND guild_id = ?1 AND active = 1 AND stock != 0`,
    guildId,
    itemId,
  );
  if (reserved.changes !== 1) throw new ShopError('sold_out', 'その商品は売り切れです。');

  // 2. 送金と記録（すべて同じ条件付き・引き落としは最後）
  const now = Date.now();
  const results = await db.batch([
    [`UPDATE balances SET balance = balance + ?3 WHERE guild_id = ?1 AND user_id = ?4 AND ${PAY_GUARD}`,
      guildId, buyerId, item.price, item.seller_id],
    [`INSERT INTO purchases (guild_id, item_id, buyer_id, seller_id, name, price, image_url, created_at)
      SELECT ?1, ?5, ?2, ?4, ?6, ?3, ?7, ?8 WHERE ${PAY_GUARD}`,
      guildId, buyerId, item.price, item.seller_id, itemId, item.name, item.image_url, now],
    [`INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)
      SELECT ?1, ?2, -?3, 'shop:buy', 'item:' || ?4, ?5 WHERE ${PAY_GUARD}`,
      guildId, buyerId, item.price, itemId, now],
    [`INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)
      SELECT ?1, ?4, ?3, 'shop:sell', 'item:' || ?5, ?6 WHERE ${PAY_GUARD}`,
      guildId, buyerId, item.price, item.seller_id, itemId, now],
    [`UPDATE balances SET balance = balance - ?3 WHERE guild_id = ?1 AND user_id = ?2 AND ${PAY_GUARD}`,
      guildId, buyerId, item.price],
  ]);

  // 3. 支払えなかったら在庫を元に戻す
  if (results.at(-1).changes !== 1) {
    await db.run(
      `UPDATE shop_items
          SET stock = CASE WHEN stock >= 0 THEN stock + 1 ELSE stock END,
              sold = sold - 1,
              active = CASE WHEN stock = 0 THEN 1 ELSE active END
        WHERE id = ?2 AND guild_id = ?1`,
      guildId,
      itemId,
    );
    throw new ShopError('insufficient', '残高が足りません。');
  }
  return item;
}

export async function inventoryOf(db, guildId, userId) {
  return db.all(
    `SELECT item_id, name, COUNT(*) AS count, SUM(price) AS total, MAX(created_at) AS last_at
       FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2
      GROUP BY item_id, name ORDER BY last_at DESC LIMIT 25`,
    guildId,
    userId,
  );
}

export async function salesOf(db, guildId, userId) {
  return db.all(
    `SELECT name, COUNT(*) AS count, SUM(price) AS total FROM purchases
      WHERE guild_id = ?1 AND seller_id = ?2 GROUP BY item_id, name ORDER BY total DESC LIMIT 10`,
    guildId,
    userId,
  );
}
