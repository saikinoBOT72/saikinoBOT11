/**
 * 釣りゲームの保存まわり（D1）。
 *
 * 無料枠を減らさないための決めごと。
 *  ・1回の操作でまとめて書けるものは batch() で1往復にする
 *  ・残数の判定は「読んでから書く」ではなく WHERE 付き UPDATE の件数で見る
 *    （同時に押されても餌が二重に減らない）
 *  ・島の様子は seen_at の新しいセッションを引くだけ。専用テーブルは持たない
 */
import { BAIT_PRICE, DEFAULT_ROD, FISH_BY_ID, priceOf } from './fishing.js';

/** 何秒さわらなければ島から消えるか。 */
export const PRESENCE_SECONDS = 90;
/** 合鍵の寿命。 */
export const SESSION_HOURS = 12;
/** 在庫として持てる上限。これ以上は売ってから。 */
export const INVENTORY_LIMIT = 200;

const now = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ 釣り人 */

export async function getPlayer(db, guildId, userId) {
  const row = await db.get(
    'SELECT rod, bait, casts, landed FROM fishing_players WHERE guild_id = ?1 AND user_id = ?2',
    guildId, userId,
  );
  if (row) return row;
  const at = now();
  await db.run(
    `INSERT INTO fishing_players (guild_id, user_id, rod, bait, casts, landed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?4)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    guildId, userId, DEFAULT_ROD, at,
  );
  return { rod: DEFAULT_ROD, bait: 0, casts: 0, landed: 0 };
}

export async function addBait(db, guildId, userId, count) {
  await getPlayer(db, guildId, userId);
  await db.run(
    'UPDATE fishing_players SET bait = bait + ?3, updated_at = ?4 WHERE guild_id = ?1 AND user_id = ?2',
    guildId, userId, count, now(),
  );
}

export async function setRod(db, guildId, userId, rodKey) {
  await getPlayer(db, guildId, userId);
  await db.run(
    'UPDATE fishing_players SET rod = ?3, updated_at = ?4 WHERE guild_id = ?1 AND user_id = ?2',
    guildId, userId, rodKey, now(),
  );
}

/**
 * 餌を1つ使って1回投げる。餌が無ければ false。
 * 読んでから書くのではなく WHERE bait > 0 で弾くので、連打しても二重に減らない。
 */
export async function consumeBait(db, guildId, userId) {
  const result = await db.run(
    `UPDATE fishing_players SET bait = bait - 1, casts = casts + 1, updated_at = ?3
     WHERE guild_id = ?1 AND user_id = ?2 AND bait > 0`,
    guildId, userId, now(),
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------ 釣果 */

export async function countInventory(db, guildId, userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM fishing_catches WHERE guild_id = ?1 AND user_id = ?2',
    guildId, userId,
  );
  return row?.n ?? 0;
}

/**
 * 取り込み成功。在庫と図鑑に1件ずつ足して、釣った回数を進める。
 * 4つの書き込みを1往復にまとめる。
 */
export async function recordCatch(db, guildId, userId, fishId, sizeMul) {
  const fish = FISH_BY_ID.get(fishId);
  const price = priceOf(fish, sizeMul);
  const at = now();
  await db.batch([
    [`INSERT INTO fishing_catches (guild_id, user_id, fish_id, size_mul, price, caught_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, guildId, userId, fishId, sizeMul, price, at],
    [`INSERT INTO fishing_dex (guild_id, user_id, fish_id, count, best_mul, first_at)
      VALUES (?1, ?2, ?3, 1, ?4, ?5)
      ON CONFLICT (guild_id, user_id, fish_id)
      DO UPDATE SET count = count + 1, best_mul = MAX(best_mul, ?4)`,
      guildId, userId, fishId, sizeMul, at],
    [`UPDATE fishing_players SET landed = landed + 1, updated_at = ?3
      WHERE guild_id = ?1 AND user_id = ?2`, guildId, userId, at],
  ]);
  return { fish, price, sizeMul };
}

/** 在庫の一覧。種類ごとにまとめず、1匹ずつ大きさが見えるように返す。 */
export async function listCatches(db, guildId, userId, limit = 50) {
  return db.all(
    `SELECT id, fish_id, size_mul, price FROM fishing_catches
     WHERE guild_id = ?1 AND user_id = ?2
     ORDER BY price DESC, id ASC LIMIT ?3`,
    guildId, userId, limit,
  );
}

/** 種類ごとにまとめた在庫（売却画面用）。 */
export async function inventorySummary(db, guildId, userId) {
  return db.all(
    `SELECT fish_id, COUNT(*) AS n, SUM(price) AS total, MAX(size_mul) AS best
     FROM fishing_catches WHERE guild_id = ?1 AND user_id = ?2
     GROUP BY fish_id ORDER BY total DESC`,
    guildId, userId,
  );
}

/** まとめて売る。売れた合計と匹数を返す。 */
export async function sellAll(db, guildId, userId, { rarity = null } = {}) {
  const ids = rarityIds(rarity);
  const where = ids ? ` AND fish_id IN (${ids.join(',')})` : '';
  const row = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS total FROM fishing_catches
     WHERE guild_id = ?1 AND user_id = ?2${where}`,
    guildId, userId,
  );
  if (!row || row.n === 0) return { count: 0, total: 0 };
  await db.run(
    `DELETE FROM fishing_catches WHERE guild_id = ?1 AND user_id = ?2${where}`,
    guildId, userId,
  );
  return { count: row.n, total: row.total };
}

function rarityIds(rarity) {
  if (!rarity) return null;
  const ids = [...FISH_BY_ID.values()].filter((fish) => fish.rarity === rarity).map((fish) => fish.id);
  return ids.length > 0 ? ids : [-1];
}

export async function dexOf(db, guildId, userId) {
  const rows = await db.all(
    'SELECT fish_id, count, best_mul FROM fishing_dex WHERE guild_id = ?1 AND user_id = ?2',
    guildId, userId,
  );
  return new Map(rows.map((row) => [row.fish_id, row]));
}

/* ------------------------------------------------------------------ 合鍵 */

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** URL発行。同じ人の古い合鍵は消して1本だけにする。 */
export async function issueSession(db, guildId, userId, displayName) {
  const token = makeToken();
  const at = now();
  await db.batch([
    ['DELETE FROM fishing_sessions WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    [`INSERT INTO fishing_sessions
        (token, guild_id, user_id, display_name, seat, nonce, pending, seen_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, NULL, 0, NULL, ?5, ?6)`,
      token, guildId, userId, displayName, at, at + SESSION_HOURS * 3600],
  ]);
  return token;
}

export async function getSession(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null;
  const row = await db.get('SELECT * FROM fishing_sessions WHERE token = ?1', token);
  if (!row) return null;
  if (row.expires_at <= now()) return null;
  return row;
}

/** 席に座る／立つ。空いていない席は取れない。 */
export async function takeSeat(db, token, guildId, seat) {
  if (seat === null) {
    await db.run('UPDATE fishing_sessions SET seat = NULL, seen_at = ?2 WHERE token = ?1', token, now());
    return true;
  }
  const at = now();
  const result = await db.run(
    `UPDATE fishing_sessions SET seat = ?3, seen_at = ?4
     WHERE token = ?1 AND NOT EXISTS (
       SELECT 1 FROM fishing_sessions AS other
       WHERE other.guild_id = ?2 AND other.seat = ?3 AND other.token <> ?1
         AND other.seen_at > ?5
     )`,
    token, guildId, seat, at, at - PRESENCE_SECONDS,
  );
  return result.changes === 1;
}

/** さわった印だけ付ける（島にいることを知らせる）。 */
export async function touch(db, token) {
  await db.run('UPDATE fishing_sessions SET seen_at = ?2 WHERE token = ?1', token, now());
}

/** 取り込み待ちのあたりを記録する。nonce を進めるので使い回しはできない。 */
export async function startFight(db, token, pending) {
  const at = now();
  const result = await db.run(
    `UPDATE fishing_sessions SET nonce = nonce + 1, pending = ?2, seen_at = ?3
     WHERE token = ?1 AND pending IS NULL`,
    token, JSON.stringify(pending), at,
  );
  return result.changes === 1;
}

/** あたりを片付ける。釣れたときは他の人に見せる情報も残す。 */
export async function finishFight(db, token, landed, fishId = null, sizeMul = null) {
  const at = now();
  if (landed) {
    await db.run(
      `UPDATE fishing_sessions
       SET pending = NULL, last_fish_id = ?2, last_size_mul = ?3, last_catch_at = ?4, seen_at = ?4
       WHERE token = ?1`,
      token, fishId, sizeMul, at,
    );
  } else {
    await db.run('UPDATE fishing_sessions SET pending = NULL, seen_at = ?2 WHERE token = ?1', token, at);
  }
}

/** 島にいる人たち。90秒さわっていない人は消えている扱い。 */
export async function island(db, guildId) {
  return db.all(
    `SELECT user_id, display_name, seat, last_fish_id, last_size_mul, last_catch_at
     FROM fishing_sessions
     WHERE guild_id = ?1 AND seat IS NOT NULL AND seen_at > ?2
     ORDER BY seat`,
    guildId, now() - PRESENCE_SECONDS,
  );
}

/** 期限切れの合鍵を掃除する（cron から呼ぶ）。 */
export async function sweepSessions(db) {
  const result = await db.run('DELETE FROM fishing_sessions WHERE expires_at <= ?1', now());
  return result.changes;
}

export { BAIT_PRICE };
