import { startOfToday } from './format.js';

/** よくある報告アクションのプリセット。 */
export const PRESET_ACTIVITIES = [
  { name: '筋トレ', emoji: '💪', reward: 50, cooldown_sec: 21600, daily_limit: 2, description: '筋トレした報告' },
  { name: 'ランニング', emoji: '🏃', reward: 60, cooldown_sec: 21600, daily_limit: 2, description: '走った報告' },
  { name: '勉強', emoji: '📚', reward: 40, cooldown_sec: 10800, daily_limit: 3, description: '勉強した報告' },
  { name: '早起き', emoji: '🌅', reward: 30, cooldown_sec: 0, daily_limit: 1, description: '早起きできた報告' },
  { name: '自炊', emoji: '🍳', reward: 30, cooldown_sec: 0, daily_limit: 3, description: '自炊した報告' },
];

export async function listActivities(db, guildId) {
  return db.all('SELECT * FROM activities WHERE guild_id = ?1 ORDER BY reward DESC, name ASC', guildId);
}

export async function getActivity(db, guildId, name) {
  return db.get('SELECT * FROM activities WHERE guild_id = ?1 AND name = ?2', guildId, name);
}

export async function upsertActivity(db, guildId, activity) {
  const current = await getActivity(db, guildId, activity.name);
  const merged = {
    emoji: activity.emoji ?? current?.emoji ?? null,
    reward: activity.reward ?? current?.reward ?? 0,
    cooldown_sec: activity.cooldown_sec ?? current?.cooldown_sec ?? 0,
    daily_limit: activity.daily_limit ?? current?.daily_limit ?? 0,
    description: activity.description ?? current?.description ?? null,
  };
  await db.run(
    `INSERT INTO activities (guild_id, name, emoji, reward, cooldown_sec, daily_limit, description, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(guild_id, name) DO UPDATE SET
       emoji = excluded.emoji, reward = excluded.reward, cooldown_sec = excluded.cooldown_sec,
       daily_limit = excluded.daily_limit, description = excluded.description`,
    guildId,
    activity.name,
    merged.emoji,
    merged.reward,
    merged.cooldown_sec,
    merged.daily_limit,
    merged.description,
    current?.created_at ?? Date.now(),
  );
  return getActivity(db, guildId, activity.name);
}

export async function removeActivity(db, guildId, name) {
  const result = await db.run('DELETE FROM activities WHERE guild_id = ?1 AND name = ?2', guildId, name);
  return result.changes > 0;
}

export async function countToday(db, guildId, userId, name, calendar) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at >= ?4',
    guildId,
    userId,
    name,
    startOfToday(calendar),
  );
  return row?.n ?? 0;
}

/**
 * 報告できる状態か判定する。
 * @returns {{ok: true} | {ok: false, reason: 'cooldown', retryAtMs: number} | {ok: false, reason: 'daily', limit: number}}
 */
export async function canReport(db, guildId, userId, activity, calendar) {
  if (activity.daily_limit > 0) {
    const today = await countToday(db, guildId, userId, activity.name, calendar);
    if (today >= activity.daily_limit) return { ok: false, reason: 'daily', limit: activity.daily_limit };
  }
  if (activity.cooldown_sec > 0) {
    const row = await db.get(
      'SELECT MAX(created_at) AS at FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
      guildId,
      userId,
      activity.name,
    );
    if (row?.at) {
      const retryAtMs = row.at + activity.cooldown_sec * 1000;
      if (retryAtMs > Date.now()) return { ok: false, reason: 'cooldown', retryAtMs };
    }
  }
  return { ok: true };
}

export async function logReport(db, guildId, userId, name, reward, note = null) {
  await db.run(
    'INSERT INTO activity_logs (guild_id, user_id, activity, reward, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    guildId,
    userId,
    name,
    reward,
    note,
    Date.now(),
  );
}

export async function reportStats(db, guildId, userId) {
  const total = await db.get(
    'SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2',
    guildId,
    userId,
  );
  const byActivity = await db.all(
    `SELECT activity, COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs
      WHERE guild_id = ?1 AND user_id = ?2 GROUP BY activity ORDER BY n DESC LIMIT 10`,
    guildId,
    userId,
  );
  return { total: total ?? { n: 0, sum: 0 }, byActivity };
}
