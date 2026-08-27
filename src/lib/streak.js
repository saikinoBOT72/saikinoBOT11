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

function previousDay(key) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function getStreak(db, guildId, userId, timezone) {
  const row = await db.get('SELECT * FROM streaks WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  if (!row) return { current: 0, best: 0, lastDate: null, alive: false };
  const today = dateKey(timezone);
  // 今日か昨日の報告があれば連続は生きている
  const alive = row.last_date === today || row.last_date === previousDay(today);
  return { current: alive ? row.current : 0, best: row.best, lastDate: row.last_date, alive };
}

/**
 * 報告があったので連続日数を進める。
 * @returns {Promise<{current: number, best: number, isNewDay: boolean}>}
 */
export async function touchStreak(db, guildId, userId, timezone) {
  const today = dateKey(timezone);
  const row = await db.get('SELECT * FROM streaks WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);

  if (!row) {
    await db.run(
      'INSERT INTO streaks (guild_id, user_id, current, best, last_date) VALUES (?1, ?2, 1, 1, ?3)',
      guildId,
      userId,
      today,
    );
    return { current: 1, best: 1, isNewDay: true };
  }
  if (row.last_date === today) {
    return { current: row.current, best: row.best, isNewDay: false };
  }

  const current = row.last_date === previousDay(today) ? row.current + 1 : 1;
  const best = Math.max(row.best, current);
  await db.run(
    'UPDATE streaks SET current = ?3, best = ?4, last_date = ?5 WHERE guild_id = ?1 AND user_id = ?2',
    guildId,
    userId,
    current,
    best,
    today,
  );
  return { current, best, isNewDay: true };
}

export async function listStreakRewards(db, guildId) {
  return db.all('SELECT * FROM streak_rewards WHERE guild_id = ?1 ORDER BY days ASC', guildId);
}

export async function upsertStreakReward(db, guildId, days, reward) {
  await db.run(
    `INSERT INTO streak_rewards (guild_id, days, reward) VALUES (?1, ?2, ?3)
     ON CONFLICT(guild_id, days) DO UPDATE SET reward = excluded.reward`,
    guildId,
    days,
    reward,
  );
}

export async function removeStreakReward(db, guildId, days) {
  const result = await db.run('DELETE FROM streak_rewards WHERE guild_id = ?1 AND days = ?2', guildId, days);
  return result.changes > 0;
}

/**
 * ちょうどその日数に到達したときのボーナスを支払う。
 * @returns {Promise<{days: number, reward: number} | null>}
 */
export async function payStreakBonus(db, guildId, userId, days) {
  const row = await db.get('SELECT * FROM streak_rewards WHERE guild_id = ?1 AND days = ?2', guildId, days);
  if (!row || row.reward <= 0) return null;
  await deposit(db, guildId, userId, row.reward, 'streak', `${days}日連続`);
  return { days, reward: row.reward };
}
