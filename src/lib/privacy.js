import { refund } from './rps.js';

/**
 * このBotが保存している、そのユーザーに関わるデータの件数を数える。
 * 「何が保存されているか」を本人に見せるために使う。
 */
export async function countUserData(db, guildId, userId) {
  const one = async (sql) => (await db.get(sql, guildId, userId))?.n ?? 0;
  return {
    balance: (await db.get('SELECT balance FROM balances WHERE guild_id = ?1 AND user_id = ?2', guildId, userId))?.balance ?? 0,
    ledger: await one('SELECT COUNT(*) AS n FROM ledger WHERE guild_id = ?1 AND user_id = ?2'),
    reports: await one('SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2'),
    items: await one('SELECT COUNT(*) AS n FROM shop_items WHERE guild_id = ?1 AND seller_id = ?2'),
    purchases: await one('SELECT COUNT(*) AS n FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2'),
  };
}

/**
 * 本人の求めに応じてデータを消す（Discord の開発者ポリシーが求める削除手段）。
 *
 * 他の人が買った履歴そのものは相手の記録なので残すが、出品者としての
 * ユーザーIDは伏せ字にして、本人を特定できる情報は残らないようにする。
 * 進行中のじゃんけんがあれば、相手の賭け金を返してから消す。
 */
export async function deleteUserData(db, guildId, userId) {
  const before = await countUserData(db, guildId, userId);

  const openMatches = await db.all(
    `SELECT * FROM rps_matches
      WHERE guild_id = ?1 AND status IN ('pending', 'playing') AND (challenger_id = ?2 OR opponent_id = ?2)`,
    guildId,
    userId,
  );
  for (const match of openMatches) {
    const claimed = await db.run(
      "UPDATE rps_matches SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')",
      match.id,
    );
    if (claimed.changes === 1 && match.status === 'playing') await refund(db, match);
  }

  await db.batch([
    ['DELETE FROM balances WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM ledger WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM shop_items WHERE guild_id = ?1 AND seller_id = ?2', guildId, userId],
    ['DELETE FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2', guildId, userId],
    ["UPDATE purchases SET seller_id = 'deleted' WHERE guild_id = ?1 AND seller_id = ?2", guildId, userId],
    ['DELETE FROM rps_matches WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2)', guildId, userId],
  ]);

  return before;
}
