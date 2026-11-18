import { refund } from './rps.js';
import { refundEscrow } from './chinchiro.js';
import { refundDuel } from './duel.js';
import { cancelPoll } from './polls.js';

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
    streaks: await one('SELECT COUNT(*) AS n FROM streaks WHERE guild_id = ?1 AND user_id = ?2'),
    titles: await one('SELECT COUNT(*) AS n FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2'),
    omikuji: await one('SELECT COUNT(*) AS n FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2'),
    lottery: await one('SELECT COUNT(*) AS n FROM lottery_tickets WHERE guild_id = ?1 AND user_id = ?2'),
    polls: await one(
      `SELECT (SELECT COUNT(*) FROM polls WHERE guild_id = ?1 AND owner_id = ?2)
            + (SELECT COUNT(*) FROM poll_bets WHERE user_id = ?2 AND poll_id IN (SELECT id FROM polls WHERE guild_id = ?1)) AS n`,
    ),
    games: await one(
      `SELECT (SELECT COUNT(*) FROM rps_matches WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2))
            + (SELECT COUNT(*) FROM chinchiro_matches WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2))
            + (SELECT COUNT(*) FROM duels WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2))
            + (SELECT COUNT(*) FROM yacht_records WHERE guild_id = ?1 AND user_id = ?2) AS n`,
    ),
  };
}

/** 卓のゲーム。座っている人の ID は state（JSON）の中にもある。 */
const CARD_TABLES = ['blackjack_tables', 'poker_tables', 'pig_tables', 'chohan_tables', 'yacht_tables'];

/** その人が卓の中身（JSON）に出てくるか。ID は数字だけなので、引用符ごと探せば取り違えない。 */
const IN_STATE = `(host_id = ?2 OR state LIKE '%"' || ?2 || '"%')`;

/**
 * いま参加している卓。卓は何人もの賭け金を預かっているので、途中で1人だけ抜くと
 * 精算が壊れる。終わるまで（長くても15分）待ってもらう。
 */
export async function activeTables(db, guildId, userId) {
  const found = [];
  for (const table of CARD_TABLES) {
    const row = await db.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?1 AND status IN ('joining', 'playing') AND ${IN_STATE}`,
      guildId,
      userId,
    );
    if (row?.n > 0) found.push(table);
  }
  return found;
}

/**
 * 本人の求めに応じてデータを消す（Discord の開発者ポリシーが求める削除手段）。
 *
 * 【消すもの】その人の残高・履歴・報告・連続記録・称号・おみくじ・宝くじの券・出品・購入・
 *   ゲームの記録・予想大会の賭け・プロフィール。
 * 【伏せるもの】ほかの人の記録として残る必要があるもの（その人から買った履歴、
 *   宝くじの当選者、予想大会の出題者）は、行を残して ID だけ 'deleted' にする。
 * 【先に片付けるもの】進行中の1対1の勝負は中止して相手に預かりを返す。
 *   本人が立てた予想大会は中止して全員に返す。
 *
 * 参加中の卓があるときは消さずに { blocked } を返す（終わってからやり直してもらう）。
 * @returns {Promise<{blocked: string[]} | {before: object}>}
 */
export async function deleteUserData(db, guildId, userId) {
  const blocked = await activeTables(db, guildId, userId);
  if (blocked.length > 0) return { blocked };

  const before = await countUserData(db, guildId, userId);

  // 進行中の1対1は、相手の預かりを返してから消す
  for (const match of await db.all(
    `SELECT * FROM rps_matches WHERE guild_id = ?1 AND status IN ('pending', 'playing') AND (challenger_id = ?2 OR opponent_id = ?2)`,
    guildId,
    userId,
  )) {
    const claimed = await db.run("UPDATE rps_matches SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')", match.id);
    if (claimed.changes === 1 && match.status === 'playing') await refund(db, match);
  }
  for (const match of await db.all(
    `SELECT * FROM chinchiro_matches WHERE guild_id = ?1 AND status IN ('pending', 'playing') AND (challenger_id = ?2 OR opponent_id = ?2)`,
    guildId,
    userId,
  )) {
    const claimed = await db.run("UPDATE chinchiro_matches SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')", match.id);
    if (claimed.changes === 1 && match.status === 'playing') await refundEscrow(db, match);
  }
  for (const duel of await db.all(
    `SELECT * FROM duels WHERE guild_id = ?1 AND status IN ('pending', 'playing') AND (challenger_id = ?2 OR opponent_id = ?2)`,
    guildId,
    userId,
  )) {
    const claimed = await db.run("UPDATE duels SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')", duel.id);
    if (claimed.changes === 1 && duel.status === 'playing') await refundDuel(db, duel);
  }

  // 本人が立てた、まだ終わっていない予想大会は中止して全員に返す
  for (const poll of await db.all(
    "SELECT * FROM polls WHERE guild_id = ?1 AND owner_id = ?2 AND status IN ('open', 'closed')",
    guildId,
    userId,
  )) {
    await cancelPoll(db, poll);
  }

  const POLLS_HERE = 'poll_id IN (SELECT id FROM polls WHERE guild_id = ?1)';
  await db.batch([
    ['DELETE FROM balances WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM ledger WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM streaks WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM profiles WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM seen_rules WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM scratch_cards WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM yacht_records WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM doors_games WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ['DELETE FROM lottery_tickets WHERE guild_id = ?1 AND user_id = ?2', guildId, userId],
    ["UPDATE lottery_draws SET winner_id = 'deleted' WHERE guild_id = ?1 AND winner_id = ?2", guildId, userId],
    ['DELETE FROM shop_items WHERE guild_id = ?1 AND seller_id = ?2', guildId, userId],
    ['DELETE FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2', guildId, userId],
    ["UPDATE purchases SET seller_id = 'deleted' WHERE guild_id = ?1 AND seller_id = ?2", guildId, userId],
    [`DELETE FROM poll_bets WHERE user_id = ?2 AND ${POLLS_HERE}`, guildId, userId],
    ["UPDATE polls SET owner_id = 'deleted' WHERE guild_id = ?1 AND owner_id = ?2", guildId, userId],
    ['DELETE FROM rps_matches WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2)', guildId, userId],
    ['DELETE FROM chinchiro_matches WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2)', guildId, userId],
    ['DELETE FROM duels WHERE guild_id = ?1 AND (challenger_id = ?2 OR opponent_id = ?2)', guildId, userId],
    ['DELETE FROM match_results WHERE guild_id = ?1 AND (winner_id = ?2 OR loser_id = ?2)', guildId, userId],
    // 終わった卓の記録は、何人ぶんもの手札や得点が1行に入っている。本人が出てくる卓は丸ごと消す
    ...CARD_TABLES.map((table) => [`DELETE FROM ${table} WHERE guild_id = ?1 AND status IN ('done', 'cancelled') AND ${IN_STATE}`, guildId, userId]),
  ]);

  return { before };
}
