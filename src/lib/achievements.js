import { deposit, getBalance } from './economy.js';
import { getStreak } from './streak.js';

/** 管理者が選べる達成条件。 */
export const CONDITION_TYPES = {
  total_reports: { label: '報告の合計回数', unit: '回', needsActivity: false },
  activity_reports: { label: '特定アクションの回数', unit: '回', needsActivity: true },
  streak: { label: '連続報告日数', unit: '日', needsActivity: false },
  balance: { label: '所持金', unit: '', needsActivity: false },
};

export function describeCondition(achievement, settings) {
  const type = CONDITION_TYPES[achievement.condition_type];
  if (!type) return '不明な条件';
  if (achievement.condition_type === 'activity_reports') {
    return `「${achievement.activity_name}」を ${achievement.threshold} 回`;
  }
  if (achievement.condition_type === 'balance') {
    return `所持金 ${settings ? settings.currency_emoji : ''}${achievement.threshold} 以上`;
  }
  return `${type.label} ${achievement.threshold} ${type.unit}`;
}

export async function listAchievements(db, guildId) {
  return db.all('SELECT * FROM achievements WHERE guild_id = ?1 ORDER BY threshold ASC, id ASC', guildId);
}

export async function getAchievement(db, guildId, id) {
  return db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function createAchievement(db, guildId, achievement) {
  const result = await db.run(
    `INSERT INTO achievements (guild_id, name, emoji, description, condition_type, threshold, activity_name, reward, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(guild_id, name) DO UPDATE SET
       emoji = excluded.emoji, description = excluded.description, condition_type = excluded.condition_type,
       threshold = excluded.threshold, activity_name = excluded.activity_name, reward = excluded.reward`,
    guildId,
    achievement.name,
    achievement.emoji ?? null,
    achievement.description ?? null,
    achievement.condition_type,
    achievement.threshold,
    achievement.activity_name ?? null,
    achievement.reward ?? 0,
    Date.now(),
  );
  return result.lastRowId
    ? getAchievement(db, guildId, result.lastRowId)
    : db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND name = ?2', guildId, achievement.name);
}

export async function removeAchievement(db, guildId, id) {
  const result = await db.run('DELETE FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
  await db.run('DELETE FROM user_achievements WHERE guild_id = ?1 AND achievement_id = ?2', guildId, id);
  return result.changes > 0;
}

/** その人が獲得済みの称号。 */
export async function earnedBy(db, guildId, userId) {
  return db.all(
    `SELECT a.*, u.earned_at FROM user_achievements u
       JOIN achievements a ON a.id = u.achievement_id
      WHERE u.guild_id = ?1 AND u.user_id = ?2
      ORDER BY u.earned_at DESC`,
    guildId,
    userId,
  );
}

/** 条件の判定に使う数値を、必要なものだけ集める。 */
async function collectStats(db, { guildId, userId, timezone }, pending) {
  const types = new Set(pending.map((achievement) => achievement.condition_type));
  const stats = { activities: new Map() };

  if (types.has('total_reports')) {
    const row = await db.get(
      'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2',
      guildId,
      userId,
    );
    stats.totalReports = row?.n ?? 0;
  }
  if (types.has('streak')) {
    stats.streak = (await getStreak(db, guildId, userId, timezone)).best;
  }
  if (types.has('balance')) {
    stats.balance = await getBalance(db, guildId, userId);
  }
  if (types.has('activity_reports')) {
    const names = [...new Set(pending.filter((a) => a.condition_type === 'activity_reports').map((a) => a.activity_name))];
    for (const name of names) {
      const row = await db.get(
        'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
        guildId,
        userId,
        name,
      );
      stats.activities.set(name, row?.n ?? 0);
    }
  }
  return stats;
}

function meets(achievement, stats) {
  switch (achievement.condition_type) {
    case 'total_reports':
      return (stats.totalReports ?? 0) >= achievement.threshold;
    case 'streak':
      return (stats.streak ?? 0) >= achievement.threshold;
    case 'balance':
      return (stats.balance ?? 0) >= achievement.threshold;
    case 'activity_reports':
      return (stats.activities.get(achievement.activity_name) ?? 0) >= achievement.threshold;
    default:
      return false;
  }
}

/**
 * まだ持っていない称号の条件を満たしたか調べ、満たしていれば付与する。
 * @returns {Promise<Array<object>>} 新しく獲得した称号
 */
export async function evaluate(db, { guildId, userId, timezone }) {
  const all = await listAchievements(db, guildId);
  if (all.length === 0) return [];

  const owned = await db.all(
    'SELECT achievement_id FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2',
    guildId,
    userId,
  );
  const ownedIds = new Set(owned.map((row) => row.achievement_id));
  const pending = all.filter((achievement) => !ownedIds.has(achievement.id));
  if (pending.length === 0) return [];

  const stats = await collectStats(db, { guildId, userId, timezone }, pending);
  const unlocked = [];

  for (const achievement of pending) {
    if (!meets(achievement, stats)) continue;
    const claimed = await db.run(
      'INSERT OR IGNORE INTO user_achievements (guild_id, user_id, achievement_id, earned_at) VALUES (?1, ?2, ?3, ?4)',
      guildId,
      userId,
      achievement.id,
      Date.now(),
    );
    if (claimed.changes !== 1) continue;
    if (achievement.reward > 0) {
      await deposit(db, guildId, userId, achievement.reward, 'achievement', achievement.name);
    }
    unlocked.push(achievement);
  }
  return unlocked;
}
