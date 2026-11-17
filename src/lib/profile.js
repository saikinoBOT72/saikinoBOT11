/**
 * プロフィール（ほかの人から見える自分のまとめ）。
 *
 * 【見せないこともできる】
 * 所持金や戦績を人に見られたくない人もいるので、本人が「見せない」にできる。
 * 見せないにしても、ランキングや公開の結果表示（その場でみんなに見えているもの）は変わらない。
 */
import { getBalance, rankOf } from './economy.js';
import { earnedBy, equippedTitle } from './achievements.js';
import { allStreaks } from './streak.js';

export async function isProfileHidden(db, guildId, userId) {
  const row = await db.get('SELECT hide_profile FROM profiles WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  return Boolean(row?.hide_profile);
}

/** 見せる／見せないを切り替える。切り替えたあとの状態（true＝見せない）を返す。 */
export async function toggleProfileHidden(db, guildId, userId) {
  await db.run(
    `INSERT INTO profiles (guild_id, user_id, hide_profile) VALUES (?1, ?2, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET hide_profile = 1 - hide_profile`,
    guildId,
    userId,
  );
  return isProfileHidden(db, guildId, userId);
}

/** プロフィールに載せる中身。口座が無い人は null。 */
export async function profileOf(db, guildId, userId, calendar) {
  const account = await db.get('SELECT 1 AS found FROM balances WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  if (!account) return null;
  const [balance, rank, title, earned, streaks, reports, record] = await Promise.all([
    getBalance(db, guildId, userId),
    rankOf(db, guildId, userId),
    equippedTitle(db, guildId, userId),
    earnedBy(db, guildId, userId),
    allStreaks(db, guildId, userId, calendar),
    db.get('SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', guildId, userId),
    db.get(
      `SELECT SUM(CASE WHEN winner_id = ?2 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN loser_id = ?2 THEN 1 ELSE 0 END) AS losses
         FROM match_results WHERE guild_id = ?1 AND (winner_id = ?2 OR loser_id = ?2)`,
      guildId,
      userId,
    ),
  ]);
  return {
    balance,
    rank,
    title,
    earned,
    streaks: streaks.filter((streak) => streak.current > 0).slice(0, 3),
    bestStreak: streaks.reduce((best, streak) => Math.max(best, streak.best), 0),
    reports: reports?.n ?? 0,
    wins: record?.wins ?? 0,
    losses: record?.losses ?? 0,
  };
}
