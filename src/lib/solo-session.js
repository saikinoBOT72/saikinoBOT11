/**
 * 1人で進める勝負（ハイ&ロー・運命の扉）の置き場所。
 *
 * 1人につき進行中の勝負は1つ。行そのものが「いま預かっている賭け」なので、
 * この行を二重に使われるとコインが増える。そこで行に版番号を持たせ、
 * 進める・降りる・負ける、のどれも「読んだときの版のまま」でなければ通さない。
 * 2台の端末で同時に押しても、通るのは先に届いた1つだけになる。
 *
 * 【降りるとき】
 * 払い戻しと行の削除を1つの処理にまとめ、どの文にも同じ条件（その版の行がまだある）を付ける。
 * 行を消すのを最後に置くので、途中で条件の真偽が変わらない（economy.withdraw と同じ考え方）。
 */

/**
 * @param {string} table  D1 のテーブル名
 * @param {string[]} fields 勝負の中身として保存する列（bet, multiplier, steps など）
 */
export function createSoloStore(table, fields) {
  const HERE = 'guild_id = ?1 AND user_id = ?2';
  const SAME_VERSION = `EXISTS (SELECT 1 FROM ${table} WHERE ${HERE} AND version = ?3)`;

  return {
    async get(db, guildId, userId) {
      return db.get(`SELECT * FROM ${table} WHERE ${HERE}`, guildId, userId);
    },

    /**
     * 新しい勝負を置く。すでに進行中なら false（同時に2つ始めても片方しか通らない）。
     * 賭け金は呼び出し側が先に預かっておくこと。false が返ったら返金する。
     */
    async start(db, guildId, userId, values) {
      const columns = fields.join(', ');
      const slots = fields.map((_, index) => `?${index + 3}`).join(', ');
      const created = await db.run(
        `INSERT OR IGNORE INTO ${table} (guild_id, user_id, ${columns}, version, created_at)
         VALUES (?1, ?2, ${slots}, 0, ?${fields.length + 3})`,
        guildId,
        userId,
        ...fields.map((field) => values[field]),
        Date.now(),
      );
      return created.changes === 1;
    },

    /** 勝負を進める。読んだあとに別の操作が入っていたら false。 */
    async advance(db, game, values) {
      const assignments = fields.map((field, index) => `${field} = ?${index + 4}`).join(', ');
      const moved = await db.run(
        `UPDATE ${table} SET ${assignments}, version = version + 1 WHERE ${HERE} AND version = ?3`,
        game.guild_id,
        game.user_id,
        game.version,
        ...fields.map((field) => values[field]),
      );
      return moved.changes === 1;
    },

    /** 外れて終わる（預かった賭け金は戻さない）。別の操作が先に入っていたら false。 */
    async lose(db, game) {
      const removed = await db.run(
        `DELETE FROM ${table} WHERE ${HERE} AND version = ?3`,
        game.guild_id,
        game.user_id,
        game.version,
      );
      return removed.changes === 1;
    },

    /**
     * 降りて受け取る。払い戻しと片付けを1つの処理で行う。
     * @returns {Promise<boolean>} 受け取れたら true。別の操作が先に入っていたら何も動かず false
     */
    async cashOut(db, game, amount, reason, detail = null) {
      const base = [game.guild_id, game.user_id, game.version];
      const statements = [];
      if (amount > 0) {
        statements.push(
          [
            `INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)
             SELECT ?1, ?2, ?4, ?5, ?6, ?7 WHERE ${SAME_VERSION}`,
            ...base, amount, reason, detail ?? null, Date.now(),
          ],
          [`UPDATE balances SET balance = balance + ?4 WHERE ${HERE} AND ${SAME_VERSION}`, ...base, amount],
        );
      }
      statements.push([`DELETE FROM ${table} WHERE ${HERE} AND version = ?3`, ...base]);
      const results = await db.batch(statements);
      return results.at(-1).changes === 1;
    },
  };
}
