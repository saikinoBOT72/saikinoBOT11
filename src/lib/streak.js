import { deposit } from './economy.js';

/** 設定タイムゾーンでの「今日」を 'YYYY-MM-DD' で返す。 */
export function dateKey(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function previousDay(key) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** そのアクションの連続記録。今日か昨日の報告があれば「生きている」。 */
export async function getStreak(db, guildId, userId, activity, timezone) {
  const row = await db.get(
    'SELECT * FROM streaks WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
    guildId,
    userId,
    activity,
  );
  if (!row) return { activity, current: 0, best: 0, alive: false };
  const today = dateKey(timezone);
  const alive = row.last_date === today || row.last_date === previousDay(today);
  return { activity, current: alive ? row.current : 0, best: row.best, alive, lastDate: row.last_date };
}

/** その人の全アクションの連続記録（続いているものを長い順に）。 */
export async function allStreaks(db, guildId, userId, timezone) {
  const rows = await db.all('SELECT * FROM streaks WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  const today = dateKey(timezone);
  const yesterday = previousDay(today);
  return rows
    .map((row) => ({
      activity: row.activity,
      current: row.last_date === today || row.last_date === yesterday ? row.current : 0,
      best: row.best,
      alive: row.last_date === today || row.last_date === yesterday,
    }))
    .sort((a, b) => b.current - a.current || b.best - a.best);
}

/**
 * そのアクションを報告したので連続日数を進める。
 * @returns {Promise<{current: number, best: number, isNewDay: boolean}>}
 */
export async function touchStreak(db, guildId, userId, activity, timezone) {
  const today = dateKey(timezone);
  const row = await db.get(
    'SELECT * FROM streaks WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
    guildId,
    userId,
    activity,
  );

  if (!row) {
    await db.run(
      'INSERT INTO streaks (guild_id, user_id, activity, current, best, last_date) VALUES (?1, ?2, ?3, 1, 1, ?4)',
      guildId,
      userId,
      activity,
      today,
    );
    return { current: 1, best: 1, isNewDay: true };
  }
  if (row.last_date === today) return { current: row.current, best: row.best, isNewDay: false };

  const current = row.last_date === previousDay(today) ? row.current + 1 : 1;
  const best = Math.max(row.best, current);
  await db.run(
    'UPDATE streaks SET current = ?4, best = ?5, last_date = ?6 WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
    guildId,
    userId,
    activity,
    current,
    best,
    today,
  );
  return { current, best, isNewDay: true };
}

export async function listStreakRewards(db, guildId, activity = null) {
  if (activity) {
    return db.all(
      'SELECT * FROM streak_rewards WHERE guild_id = ?1 AND activity = ?2 ORDER BY days ASC',
      guildId,
      activity,
    );
  }
  return db.all('SELECT * FROM streak_rewards WHERE guild_id = ?1 ORDER BY activity ASC, days ASC', guildId);
}

export async function upsertStreakReward(db, guildId, activity, days, reward) {
  await db.run(
    `INSERT INTO streak_rewards (guild_id, activity, days, reward) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(guild_id, activity, days) DO UPDATE SET reward = excluded.reward`,
    guildId,
    activity,
    days,
    reward,
  );
}

export async function removeStreakReward(db, guildId, activity, days) {
  const result = await db.run(
    'DELETE FROM streak_rewards WHERE guild_id = ?1 AND activity = ?2 AND days = ?3',
    guildId,
    activity,
    days,
  );
  return result.changes > 0;
}

/** アクション自体が消えたらボーナス設定も片付ける。 */
export async function removeStreakRewardsFor(db, guildId, activity) {
  await db.run('DELETE FROM streak_rewards WHERE guild_id = ?1 AND activity = ?2', guildId, activity);
}

/**
 * ちょうどその日数に到達したときのボーナスを支払う。
 * @returns {Promise<{days: number, reward: number} | null>}
 */
export async function payStreakBonus(db, guildId, userId, activity, days) {
  const row = await db.get(
    'SELECT * FROM streak_rewards WHERE guild_id = ?1 AND activity = ?2 AND days = ?3',
    guildId,
    activity,
    days,
  );
  if (!row || row.reward <= 0) return null;
  await deposit(db, guildId, userId, row.reward, 'streak', `${activity} ${days}日連続`);
  return { days, reward: row.reward };
}
