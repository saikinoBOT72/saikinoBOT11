import { getDb } from './db.js';
import { transfer } from './economy.js';

export class ShopError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createItem({ guildId, sellerId, name, description, price, imageUrl, imageFile, stock }) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO shop_items (guild_id, seller_id, name, description, price, image_url, image_file, stock, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(guildId, sellerId, name, description ?? null, price, imageUrl ?? null, imageFile ?? null, stock, Date.now());
  return getItem(guildId, Number(info.lastInsertRowid));
}

export function getItem(guildId, id) {
  return getDb().prepare('SELECT * FROM shop_items WHERE guild_id = ? AND id = ?').get(guildId, id);
}

export function listItems(guildId, { includeInactive = false, sellerId = null, limit = 100, offset = 0 } = {}) {
  const where = ['guild_id = ?'];
  const params = [guildId];
  if (!includeInactive) where.push('active = 1');
  if (sellerId) {
    where.push('seller_id = ?');
    params.push(sellerId);
  }
  return getDb()
    .prepare(`SELECT * FROM shop_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

export function countItems(guildId, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT COUNT(*) AS n FROM shop_items WHERE guild_id = ?'
    : 'SELECT COUNT(*) AS n FROM shop_items WHERE guild_id = ? AND active = 1';
  return getDb().prepare(sql).get(guildId).n;
}

/** patch に含めたキーだけを更新する（null を渡せば NULL クリアになる）。 */
export function updateItem(guildId, id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return getItem(guildId, id);
  getDb()
    .prepare(`UPDATE shop_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`)
    .run(...keys.map((k) => patch[k]), guildId, id);
  return getItem(guildId, id);
}

export function deactivateItem(guildId, id) {
  return getDb().prepare('UPDATE shop_items SET active = 0 WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
}

/**
 * 購入処理。在庫の減算・送金・購入履歴をひとつのトランザクションで行う。
 * 失敗時は ShopError を投げ、すべてロールバックされる。
 */
export function purchase(guildId, itemId, buyerId) {
  const db = getDb();
  const run = db.transaction(() => {
    const item = db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND id = ?').get(guildId, itemId);
    if (!item) throw new ShopError('not_found', 'その商品は見つかりませんでした。');
    if (!item.active) throw new ShopError('inactive', 'その商品は現在販売されていません。');
    if (item.seller_id === buyerId) throw new ShopError('own_item', '自分の出品は購入できません。');

    if (item.stock > 0) {
      const res = db.prepare('UPDATE shop_items SET stock = stock - 1, sold = sold + 1 WHERE id = ? AND stock > 0').run(itemId);
      if (res.changes !== 1) throw new ShopError('sold_out', 'その商品は売り切れです。');
      db.prepare('UPDATE shop_items SET active = 0 WHERE id = ? AND stock <= 0').run(itemId);
    } else if (item.stock === 0) {
      throw new ShopError('sold_out', 'その商品は売り切れです。');
    } else {
      db.prepare('UPDATE shop_items SET sold = sold + 1 WHERE id = ?').run(itemId);
    }

    const paid = transfer(guildId, buyerId, item.seller_id, item.price, 'shop:buy', `item:${itemId}`);
    if (!paid) throw new ShopError('insufficient', '残高が足りません。');

    db.prepare(
      `INSERT INTO purchases (guild_id, item_id, buyer_id, seller_id, name, price, image_url, image_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(guildId, itemId, buyerId, item.seller_id, item.name, item.price, item.image_url, item.image_file, Date.now());

    return item;
  });
  return run();
}

/** 所持アイテム（購入履歴を商品ごとにまとめたもの）。 */
export function inventoryOf(guildId, userId) {
  return getDb()
    .prepare(
      `SELECT item_id, name, COUNT(*) AS count, SUM(price) AS total, MAX(created_at) AS last_at, seller_id
       FROM purchases WHERE guild_id = ? AND buyer_id = ?
       GROUP BY item_id, name ORDER BY last_at DESC`,
    )
    .all(guildId, userId);
}

export function salesOf(guildId, userId) {
  return getDb()
    .prepare(
      `SELECT name, COUNT(*) AS count, SUM(price) AS total FROM purchases
       WHERE guild_id = ? AND seller_id = ? GROUP BY item_id, name ORDER BY total DESC`,
    )
    .all(guildId, userId);
}

export function recentBuyers(guildId, itemId, limit = 5) {
  return getDb()
    .prepare('SELECT buyer_id, created_at FROM purchases WHERE guild_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(guildId, itemId, limit);
}
