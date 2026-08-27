import { deposit, getBalance } from './economy.js';
import { getStreak } from './streak.js';

/** 管理者が選べる達成条件。 */
export const CONDITION_TYPES = {
  activity_count: { label: 'アクションの回数', unit: '回', needsActivity: true },
  activity_streak: { label: 'アクションの連続日数', unit: '日', needsActivity: true },
  total_reports: { label: '報告の合計回数（全アクション）', unit: '回', needsActivity: false },
  balance: { label: '所持金', unit: '', needsActivity: false },
};

export const CONDITION_EXAMPLES = {
  activity_count: '例: 筋トレを50回で「筋トレ王」',
  activity_streak: '例: 筋トレ30日連続で「鉄の意志」',
  total_reports: '例: 合計100回で「継続の鬼」',
  balance: '例: 所持金10000で「富豪」',
};

export function describeCondition(achievement, settings) {
  switch (achievement.condition_type) {
    case 'activity_count':
      return `「${achievement.activity_name}」を ${achievement.threshold} 回`;
    case 'activity_streak':
      return `「${achievement.activity_name}」を ${achievement.threshold} 日連続`;
    case 'total_reports':
      return `報告の合計 ${achievement.threshold} 回`;
    case 'balance':
      return `所持金 ${settings ? settings.currency_emoji : ''}${achievement.threshold} 以上`;
    default:
      return '不明な条件';
  }
}

export async function listAchievements(db, guildId) {
  return db.all('SELECT * FROM achievements WHERE guild_id = ?1 ORDER BY threshold ASC, id ASC', guildId);
}

export async function getAchievement(db, guildId, id) {
  return db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function createAchievement(db, guildId, achievement) {
  await db.run(
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
  return db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND name = ?2', guildId, achievement.name);
}

export async function removeAchievement(db, guildId, id) {
  const result = await db.run('DELETE FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
  await db.batch([
    ['DELETE FROM user_achievements WHERE guild_id = ?1 AND achievement_id = ?2', guildId, id],
    ['UPDATE profiles SET title_id = NULL WHERE guild_id = ?1 AND title_id = ?2', guildId, id],
  ]);
  return result.changes > 0;
}

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

/* ------------------------------------------------------------------ 装備している称号 */

/** 名前の横に出す称号。未設定なら null。 */
export async function equippedTitle(db, guildId, userId) {
  return db.get(
    `SELECT a.* FROM profiles p JOIN achievements a ON a.id = p.title_id
      WHERE p.guild_id = ?1 AND p.user_id = ?2`,
    guildId,
    userId,
  );
}

/** ランキング用にまとめて引く。 @returns {Promise<Map<string, object>>} */
export async function equippedTitles(db, guildId, userIds) {
  if (userIds.length === 0) return new Map();
  const placeholders = userIds.map((_, index) => `?${index + 2}`).join(', ');
  const rows = await db.all(
    `SELECT p.user_id, a.name, a.emoji FROM profiles p JOIN achievements a ON a.id = p.title_id
      WHERE p.guild_id = ?1 AND p.user_id IN (${placeholders})`,
    guildId,
    ...userIds,
  );
  return new Map(rows.map((row) => [row.user_id, row]));
}

/** 称号を装備する（titleId が null なら外す）。持っていない称号は装備できない。 */
export async function equipTitle(db, guildId, userId, titleId) {
  if (titleId !== null) {
    const owned = await db.get(
      'SELECT 1 AS ok FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2 AND achievement_id = ?3',
      guildId,
      userId,
      titleId,
    );
    if (!owned) return false;
  }
  await db.run(
    `INSERT INTO profiles (guild_id, user_id, title_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET title_id = excluded.title_id`,
    guildId,
    userId,
    titleId,
  );
  return true;
}

/** 「🏅筋トレ王」のような表示用の飾り。装備していなければ空文字。 */
export function titleTag(title) {
  if (!title) return '';
  return `${title.emoji ?? '🏅'}${title.name}`;
}

/* ------------------------------------------------------------------ 判定 */

async function collectStats(db, { guildId, userId, timezone }, pending) {
  const types = new Set(pending.map((achievement) => achievement.condition_type));
  const stats = { counts: new Map(), streaks: new Map() };

  if (types.has('total_reports')) {
    const row = await db.get('SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
    stats.totalReports = row?.n ?? 0;
  }
  if (types.has('balance')) {
    stats.balance = await getBalance(db, guildId, userId);
  }
  for (const achievement of pending) {
    const name = achievement.activity_name;
    if (!name) continue;
    if (achievement.condition_type === 'activity_count' && !stats.counts.has(name)) {
      const row = await db.get(
        'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
        guildId,
        userId,
        name,
      );
      stats.counts.set(name, row?.n ?? 0);
    }
    if (achievement.condition_type === 'activity_streak' && !stats.streaks.has(name)) {
      stats.streaks.set(name, (await getStreak(db, guildId, userId, name, timezone)).best);
    }
  }
  return stats;
}

function meets(achievement, stats) {
  switch (achievement.condition_type) {
    case 'activity_count':
      return (stats.counts.get(achievement.activity_name) ?? 0) >= achievement.threshold;
    case 'activity_streak':
      return (stats.streaks.get(achievement.activity_name) ?? 0) >= achievement.threshold;
    case 'total_reports':
      return (stats.totalReports ?? 0) >= achievement.threshold;
    case 'balance':
      return (stats.balance ?? 0) >= achievement.threshold;
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

  const owned = await db.all('SELECT achievement_id FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
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
    if (achievement.reward > 0) await deposit(db, guildId, userId, achievement.reward, 'achievement', achievement.name);
    unlocked.push(achievement);
  }
  return unlocked;
}
