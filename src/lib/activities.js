import { getDb } from './db.js';
import { startOfToday } from './format.js';

/** よくある報告アクションのプリセット。/activity preset で一括登録する。 */
export const PRESET_ACTIVITIES = [
  { name: '筋トレ', emoji: '💪', reward: 50, cooldown_sec: 21600, daily_limit: 2, need_proof: 0, description: '筋トレした報告' },
  { name: 'ランニング', emoji: '🏃', reward: 60, cooldown_sec: 21600, daily_limit: 2, need_proof: 0, description: '走った報告' },
  { name: '勉強', emoji: '📚', reward: 40, cooldown_sec: 10800, daily_limit: 3, need_proof: 0, description: '勉強した報告' },
  { name: '早起き', emoji: '🌅', reward: 30, cooldown_sec: 0, daily_limit: 1, need_proof: 0, description: '早起きできた報告' },
  { name: '自炊', emoji: '🍳', reward: 30, cooldown_sec: 0, daily_limit: 3, need_proof: 1, description: '自炊した報告（写真必須）' },
];

export function listActivities(guildId) {
  return getDb().prepare('SELECT * FROM activities WHERE guild_id = ? ORDER BY reward DESC, name ASC').all(guildId);
}

export function getActivity(guildId, name) {
  return getDb().prepare('SELECT * FROM activities WHERE guild_id = ? AND name = ?').get(guildId, name);
}

export function upsertActivity(guildId, activity) {
  const db = getDb();
  const current = getActivity(guildId, activity.name);
  const merged = {
    emoji: activity.emoji ?? current?.emoji ?? null,
    reward: activity.reward ?? current?.reward ?? 0,
    cooldown_sec: activity.cooldown_sec ?? current?.cooldown_sec ?? 0,
    daily_limit: activity.daily_limit ?? current?.daily_limit ?? 0,
    need_proof: activity.need_proof ?? current?.need_proof ?? 0,
    description: activity.description ?? current?.description ?? null,
  };
  db.prepare(
    `INSERT INTO activities (guild_id, name, emoji, reward, cooldown_sec, daily_limit, need_proof, description, created_at)
     VALUES (@guild_id, @name, @emoji, @reward, @cooldown_sec, @daily_limit, @need_proof, @description, @created_at)
     ON CONFLICT(guild_id, name) DO UPDATE SET
       emoji = excluded.emoji, reward = excluded.reward, cooldown_sec = excluded.cooldown_sec,
       daily_limit = excluded.daily_limit, need_proof = excluded.need_proof, description = excluded.description`,
  ).run({ guild_id: guildId, name: activity.name, ...merged, created_at: current?.created_at ?? Date.now() });
  return getActivity(guildId, activity.name);
}

export function removeActivity(guildId, name) {
  return getDb().prepare('DELETE FROM activities WHERE guild_id = ? AND name = ?').run(guildId, name).changes > 0;
}

/** 直近の報告時刻（epoch ms）。まだ報告が無ければ null。 */
export function lastReportedAt(guildId, userId, name) {
  const row = getDb()
    .prepare('SELECT MAX(created_at) AS at FROM activity_logs WHERE guild_id = ? AND user_id = ? AND activity = ?')
    .get(guildId, userId, name);
  return row?.at ?? null;
}

/** 今日（設定タイムゾーン基準）の報告回数。 */
export function countToday(guildId, userId, name) {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ? AND user_id = ? AND activity = ? AND created_at >= ?',
    )
    .get(guildId, userId, name, startOfToday());
  return row.n;
}

/**
 * 報告できる状態か判定する。
 * @returns {{ok: true} | {ok: false, reason: 'cooldown', retryAtMs: number} | {ok: false, reason: 'daily', limit: number}}
 */
export function canReport(guildId, userId, activity) {
  if (activity.daily_limit > 0 && countToday(guildId, userId, activity.name) >= activity.daily_limit) {
    return { ok: false, reason: 'daily', limit: activity.daily_limit };
  }
  if (activity.cooldown_sec > 0) {
    const last = lastReportedAt(guildId, userId, activity.name);
    if (last !== null) {
      const retryAtMs = last + activity.cooldown_sec * 1000;
      if (retryAtMs > Date.now()) return { ok: false, reason: 'cooldown', retryAtMs };
    }
  }
  return { ok: true };
}

export function logReport(guildId, userId, name, reward, note) {
  getDb()
    .prepare('INSERT INTO activity_logs (guild_id, user_id, activity, reward, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, name, reward, note ?? null, Date.now());
}

/** 直近 n 日間の報告回数（本人のサマリー表示用）。 */
export function reportStats(guildId, userId) {
  const db = getDb();
  return {
    total: db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId),
    byActivity: db
      .prepare(
        `SELECT activity, COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs
         WHERE guild_id = ? AND user_id = ? GROUP BY activity ORDER BY n DESC LIMIT 10`,
      )
      .all(guildId, userId),
  };
}
