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

const DAY_MS = 86400 * 1000;

/**
 * 集計する範囲（since 以上 until 未満）。
 * back が true なら、ひとつ前の期間（昨日・先週）。
 */
export function periodRange(period, calendar, now = new Date(), back = false) {
  const start = periodStart(period, calendar, now);
  if (!back || start === 0) return { since: start, until: Number.MAX_SAFE_INTEGER };
  const length = period === 'week' ? 7 * DAY_MS : DAY_MS;
  return { since: start - length, until: start };
}

/**
 * 定期発表が「ひとつ前の期間」を集計すべきか。
 *
 * 'previous' なら必ず前、'current' なら必ずいま。
 * 'auto'（既定）は、発表する時点で期間がまだ半分も過ぎていなければ前を見る。
 * 月曜の朝に出す「今週の稼ぎ」が数時間ぶんしか入らない、を防ぐため。
 */
export function looksBack(mode, period, calendar, now = new Date()) {
  if (mode === 'previous') return true;
  if (mode === 'current') return false;
  const start = periodStart(period, calendar, now);
  const length = period === 'week' ? 7 * DAY_MS : DAY_MS;
  return now.getTime() - start < length / 2;
}

export function periodLabel(period, back = false) {
  if (back) return { day: '昨日', week: '先週' }[period] ?? '全期間';
  return { day: '今日', week: '今週' }[period] ?? '全期間';
}

/** 定期発表の集計期間の選び方。 */
export const PERIOD_MODES = {
  auto: { label: 'おまかせ', hint: '期間の前半に発表するなら、ひとつ前（昨日・先週）を集計' },
  previous: { label: '昨日・先週', hint: 'いつ発表しても、ひとつ前の期間を集計' },
  current: { label: '今日・今週', hint: 'いつ発表しても、いまの期間を集計' },
};

/**
 * ランキングを計算する。
 * @returns {Promise<Array<{user_id: string, value: number}>>}
 */
export async function computeRanking(db, {
  guildId,
  metric,
  activityName = null,
  since = 0,
  until = Number.MAX_SAFE_INTEGER,
  limit = 10,
  calendar,
}) {
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
          WHERE guild_id = ?1 AND amount > 0 AND created_at >= ?2 AND created_at < ?4
          GROUP BY user_id HAVING value > 0 ORDER BY value DESC, user_id ASC LIMIT ?3`,
        guildId,
        since,
        limit,
        until,
      );

    case 'activity_count':
    case 'activity_total': {
      const from = metric === 'activity_total' ? 0 : since;
      const to = metric === 'activity_total' ? Number.MAX_SAFE_INTEGER : until;
      if (activityName) {
        return db.all(
          `SELECT user_id, COUNT(*) AS value FROM activity_logs
            WHERE guild_id = ?1 AND activity = ?2 AND created_at >= ?3 AND created_at < ?5
            GROUP BY user_id ORDER BY value DESC, user_id ASC LIMIT ?4`,
          guildId,
          activityName,
          from,
          limit,
          to,
        );
      }
      return db.all(
        `SELECT user_id, COUNT(*) AS value FROM activity_logs
          WHERE guild_id = ?1 AND created_at >= ?2 AND created_at < ?4
          GROUP BY user_id ORDER BY value DESC, user_id ASC LIMIT ?3`,
        guildId,
        from,
        limit,
        to,
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
export function rankingTitle({ metric, activityName, period, back = false }) {
  const meta = METRICS[metric];
  if (!meta) return 'ランキング';
  const target = activityName ? `「${activityName}」の` : '';
  const when = meta.usesPeriod ? `（${periodLabel(period, back)}）` : '';
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
