/**
 * 1対1の勝負の勝ち負け（戦績・相手ごとの勝敗・勝利数の称号に使う）。
 *
 * この版から数える（それより前の勝負は記録していない）。
 * 引き分け・返金・山分けは記録しない。
 */
import { GAME_NAMES } from './ledger-reasons.js';

/** 記録するゲームの名前（match_results.game → 表示名）。 */
export const MATCH_GAMES = {
  rps: 'じゃんけん',
  cc: 'チンチロ',
  rr: 'ロシアンルーレット',
  cs: 'チャージ＆シュート',
  mine: '地雷＆陣取り',
  doors: '運命の扉（2人）',
};

export async function recordMatch(db, { guildId, game, winnerId, loserId, amount = 0, now = Date.now() }) {
  if (!winnerId || !loserId || winnerId === loserId) return;
  await db.run(
    'INSERT INTO match_results (guild_id, game, winner_id, loser_id, amount, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    guildId,
    game,
    winnerId,
    loserId,
    Math.max(0, Math.floor(amount)),
    now,
  );
}

/**
 * その人の戦績。
 * @returns {Promise<{wins: number, losses: number, won: number, byGame: object[], rivals: object[], games: object[]}>}
 */
export async function statsOf(db, guildId, userId) {
  const MINE = 'guild_id = ?1 AND (winner_id = ?2 OR loser_id = ?2)';
  const [total, byGame, rivals, ledger] = await Promise.all([
    db.get(
      `SELECT SUM(CASE WHEN winner_id = ?2 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN loser_id = ?2 THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN winner_id = ?2 THEN amount ELSE 0 END) AS won
         FROM match_results WHERE ${MINE}`,
      guildId,
      userId,
    ),
    db.all(
      `SELECT game, SUM(CASE WHEN winner_id = ?2 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN loser_id = ?2 THEN 1 ELSE 0 END) AS losses
         FROM match_results WHERE ${MINE} GROUP BY game ORDER BY COUNT(*) DESC`,
      guildId,
      userId,
    ),
    db.all(
      `SELECT CASE WHEN winner_id = ?2 THEN loser_id ELSE winner_id END AS rival,
              SUM(CASE WHEN winner_id = ?2 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN loser_id = ?2 THEN 1 ELSE 0 END) AS losses
         FROM match_results WHERE ${MINE} AND winner_id != 'deleted' AND loser_id != 'deleted'
        GROUP BY rival ORDER BY COUNT(*) DESC LIMIT 5`,
      guildId,
      userId,
    ),
    // ゲームごとの収支は、コインの履歴から数える（1人用のゲームも入る）
    db.all(
      `SELECT reason, SUM(amount) AS net, SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS plays
         FROM ledger WHERE guild_id = ?1 AND user_id = ?2 AND reason LIKE '%:%' GROUP BY reason`,
      guildId,
      userId,
    ),
  ]);

  const games = new Map();
  for (const row of ledger) {
    const [game] = row.reason.split(':');
    if (!GAME_NAMES[game] || ['shop', 'admin', 'tip', 'report'].includes(game)) continue;
    const entry = games.get(game) ?? { game, name: GAME_NAMES[game], net: 0, plays: 0 };
    entry.net += row.net;
    entry.plays += row.plays;
    games.set(game, entry);
  }

  return {
    wins: total?.wins ?? 0,
    losses: total?.losses ?? 0,
    won: total?.won ?? 0,
    byGame,
    rivals,
    games: [...games.values()].filter((entry) => entry.plays > 0).sort((a, b) => b.plays - a.plays),
  };
}

/** 勝った回数（称号の条件に使う）。 */
export async function winsOf(db, guildId, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM match_results WHERE guild_id = ?1 AND winner_id = ?2', guildId, userId);
  return row?.n ?? 0;
}
