import { dateKey, previousDay, startOfDay } from './calendar.js';

export { startOfDay };

/** ランキングの集計対象。 */
export const METRICS = {
  balance: { label: '総コイン数', unit: '', needsActivity: false, usesPeriod: false },
  earned: { label: '稼いだコイン', unit: '', needsActivity: false, usesPeriod: true },
  activity_count: { label: 'アクションの回数', unit: '回', needsActivity: 'optional', usesPeriod: true },
  activity_total: { label: 'アクションの回数（累計）', unit: '回', needsActivity: 'optional', usesPeriod: false },
  activity_streak: { label: 'アクションの連続記録', unit: '日', needsActivity: true, usesPeriod: false },
};

/** 今週（月曜始まり）の始まり。日の区切りは calendar.js に合わせる。 */
export function startOfWeek(calendar, now = new Date()) {
  const today = startOfDay(calendar, now);
  const weekday = new Date(`${dateKey(calendar, now)}T00:00:00Z`).getUTCDay(); // 0=日曜
  const daysSinceMonday = (weekday + 6) % 7;
  return today - daysSinceMonday * 86400 * 1000;
}

export function periodStart(period, calendar, now = new Date()) {
  if (period === 'day') return startOfDay(calendar, now);
  if (period === 'week') return startOfWeek(calendar, now);
  return 0;
}

export function periodLabel(period) {
  return { day: '今日', week: '今週' }[period] ?? '全期間';
}

/**
 * ランキングを計算する。
 * @returns {Promise<Array<{user_id: string, value: number}>>}
 */
export async function computeRanking(db, { guildId, metric, activityName = null, since = 0, limit = 10, calendar }) {
  switch (metric) {
    case 'balance':
      return db.all(
        'SELECT user_id, balance AS value FROM balances WHERE guild_id = ?1 AND balance > 0 ORDER BY value DESC, user_id ASC LIMIT ?2',
        guildId,
        limit,
      );

    case 'earned':
      return db.all(
        `SELECT user_id, SUM(amount) AS value FROM ledger
          WHERE guild_id = ?1 AND amount > 0 AND created_at >= ?2
          GROUP BY user_id HAVING value > 0 ORDER BY value DESC, user_id ASC LIMIT ?3`,
        guildId,
        since,
        limit,
      );

    case 'activity_count':
    case 'activity_total': {
      const from = metric === 'activity_total' ? 0 : since;
      if (activityName) {
        return db.all(
          `SELECT user_id, COUNT(*) AS value FROM activity_logs
            WHERE guild_id = ?1 AND activity = ?2 AND created_at >= ?3
            GROUP BY user_id ORDER BY value DESC, user_id ASC LIMIT ?4`,
          guildId,
          activityName,
          from,
          limit,
        );
      }
      return db.all(
        `SELECT user_id, COUNT(*) AS value FROM activity_logs
          WHERE guild_id = ?1 AND created_at >= ?2
          GROUP BY user_id ORDER BY value DESC, user_id ASC LIMIT ?3`,
        guildId,
        from,
        limit,
      );
    }

    case 'activity_streak': {
      // 生死の判定は streak.isAlive と同じ（区切りを変えた直後の「先の日付」も続いている扱い）
      const today = dateKey(calendar);
      const rows = await db.all(
        `SELECT user_id, current AS value FROM streaks
          WHERE guild_id = ?1 AND activity = ?2 AND (last_date >= ?3 OR last_date = ?4) AND current > 0
          ORDER BY value DESC, user_id ASC LIMIT ?5`,
        guildId,
        activityName,
        today,
        previousDay(today),
        limit,
      );
      return rows;
    }

    default:
      return [];
  }
}

/** 「筋トレの回数（今週）」のような見出し。 */
export function rankingTitle({ metric, activityName, period }) {
  const meta = METRICS[metric];
  if (!meta) return 'ランキング';
  const target = activityName ? `「${activityName}」の` : '';
  const when = meta.usesPeriod ? `（${periodLabel(period)}）` : '';
  switch (metric) {
    case 'balance':
      return '総コイン数ランキング';
    case 'earned':
      return `稼いだコインランキング${when}`;
    case 'activity_count':
      return `${target || '報告'}回数ランキング${when}`;
    case 'activity_total':
      return `${target || '報告'}回数ランキング（累計）`;
    case 'activity_streak':
      return `${target}連続記録ランキング`;
    default:
      return 'ランキング';
  }
}

export function formatValue(metric, value, settings) {
  const meta = METRICS[metric];
  if (metric === 'balance' || metric === 'earned') {
    return `${settings.currency_emoji} ${Number(value).toLocaleString('ja-JP')}`;
  }
  return `**${Number(value).toLocaleString('ja-JP')}** ${meta?.unit ?? ''}`;
}
