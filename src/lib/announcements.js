import { deposit } from './economy.js';
import { equippedTitles, titleTag } from './achievements.js';
import { METRICS, PERIOD_MODES, computeRanking, formatValue, looksBack, periodRange, rankingTitle } from './ranking.js';
import { currentHour, dateKey } from './calendar.js';

export { currentHour };
import { embed } from '../discord/builders.js';

export const WEEKDAYS = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

const MEDALS = ['🥇', '🥈', '🥉'];

export async function listAnnouncements(db, guildId) {
  return db.all('SELECT * FROM announcements WHERE guild_id = ?1 ORDER BY id ASC', guildId);
}

export async function getAnnouncement(db, guildId, id) {
  return db.get('SELECT * FROM announcements WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function createAnnouncement(db, guildId, announcement) {
  const result = await db.run(
    `INSERT INTO announcements (guild_id, channel_id, metric, activity_name, frequency, weekday, hour, top_n, prize, enabled, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)`,
    guildId,
    announcement.channelId,
    announcement.metric,
    announcement.activityName ?? null,
    announcement.frequency,
    announcement.weekday ?? null,
    announcement.hour,
    announcement.topN,
    announcement.prize ?? 0,
    Date.now(),
  );
  return getAnnouncement(db, guildId, result.lastRowId);
}

export async function removeAnnouncement(db, guildId, id) {
  const result = await db.run('DELETE FROM announcements WHERE guild_id = ?1 AND id = ?2', guildId, id);
  return result.changes > 0;
}

export async function toggleAnnouncement(db, guildId, id) {
  await db.run('UPDATE announcements SET enabled = 1 - enabled WHERE guild_id = ?1 AND id = ?2', guildId, id);
  return getAnnouncement(db, guildId, id);
}

/** 「毎週月曜 9時」のような説明。 */
export function describeSchedule(announcement) {
  const when = announcement.frequency === 'weekly' ? `毎週${WEEKDAYS[announcement.weekday ?? 1]}` : '毎日';
  return `${when} ${announcement.hour}時`;
}

/** 発表の集計期間。'day' か 'week'。 */
export function periodOf(announcement) {
  return announcement.frequency === 'weekly' ? 'week' : 'day';
}

/** 集計期間の選び方（おまかせ・昨日先週・今日今週）。 */
export function periodModeOf(announcement) {
  return PERIOD_MODES[announcement.period] ? announcement.period : 'auto';
}

export function describeAnnouncement(announcement) {
  const title = rankingTitle({
    metric: announcement.metric,
    activityName: announcement.activity_name,
    period: periodOf(announcement),
  });
  const prize = announcement.prize > 0 ? `／1位に ${announcement.prize}` : '';
  const mode = METRICS[announcement.metric]?.usesPeriod ? `・集計 ${PERIOD_MODES[periodModeOf(announcement)].label}` : '';
  return `${title}　*(${describeSchedule(announcement)}・上位${announcement.top_n}人${prize}${mode})*`;
}

/** 集計期間の選び方を順に切り替える（おまかせ → 昨日・先週 → 今日・今週 → おまかせ）。 */
export async function cyclePeriodMode(db, guildId, id) {
  const current = await getAnnouncement(db, guildId, id);
  if (!current) return null;
  const order = Object.keys(PERIOD_MODES);
  const next = order[(order.indexOf(periodModeOf(current)) + 1) % order.length];
  await db.run('UPDATE announcements SET period = ?3 WHERE guild_id = ?1 AND id = ?2', guildId, id, next);
  return getAnnouncement(db, guildId, id);
}

/**
 * いま発表すべきものを探す。
 * 1分ごとに呼ばれるので、時が一致していてその日まだ出していないものを対象にする。
 */
/**
 * いま発表すべきものを探す。
 * 「何時に出すか」は時計どおり。「その日もう出したか」は、そのサーバーの区切りに合わせた日付で見る。
 * calendarOf はサーバーごとの数え方を返す（区切りはサーバーごとに変えられるため）。
 * @returns {Promise<Array<object & {today: string, calendar: object}>>}
 */
export async function dueAnnouncements(db, calendarOf, now = new Date()) {
  const lookup = typeof calendarOf === 'function' ? calendarOf : async () => calendarOf;
  const anyCalendar = await lookup(null);
  const hour = currentHour(anyCalendar, now);

  const rows = await db.all('SELECT * FROM announcements WHERE enabled = 1 AND hour = ?1', hour);
  const due = [];
  for (const row of rows) {
    const calendar = await lookup(row.guild_id);
    const today = dateKey(calendar, now);
    if (row.last_run_date === today) continue;
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (row.frequency === 'daily' || row.weekday === weekday) due.push({ ...row, today, calendar });
  }
  return due;
}

export async function markAnnounced(db, id, dateString) {
  await db.run('UPDATE announcements SET last_run_date = ?2 WHERE id = ?1', id, dateString);
}

/**
 * 発表用の Embed を組み立て、必要なら1位へ賞金を渡す。
 * @returns {Promise<{embed: object, winners: string[]} | null>} 対象がいなければ null
 */
export async function buildAnnouncement(db, announcement, { settings, calendar, now = new Date() }) {
  const period = periodOf(announcement);
  const usesPeriod = Boolean(METRICS[announcement.metric]?.usesPeriod);
  const back = usesPeriod && looksBack(periodModeOf(announcement), period, calendar, now);
  const { since, until } = periodRange(usesPeriod ? period : 'all', calendar, now, back);
  const rows = await computeRanking(db, {
    guildId: announcement.guild_id,
    metric: announcement.metric,
    activityName: announcement.activity_name,
    since,
    until,
    limit: announcement.top_n,
    calendar,
  });
  if (rows.length === 0) return null;

  const titles = await equippedTitles(db, announcement.guild_id, rows.map((row) => row.user_id));
  const lines = rows.map((row, index) => {
    const rank = MEDALS[index] ?? `**${index + 1}.**`;
    const tag = titleTag(titles.get(row.user_id));
    return `${rank} ${tag ? `\`${tag}\` ` : ''}<@${row.user_id}> — ${formatValue(announcement.metric, row.value, settings)}`;
  });

  const winners = [];
  if (announcement.prize > 0) {
    const top = rows[0];
    await deposit(db, announcement.guild_id, top.user_id, announcement.prize, 'ranking', '1位の賞金');
    winners.push(top.user_id);
    lines.push('', `🎁 1位の <@${top.user_id}> に ${settings.currency_emoji} ${announcement.prize} を贈りました！`);
  }

  return {
    embed: embed({
      color: 0xf1c40f,
      title: `📢 ${rankingTitle({ metric: announcement.metric, activityName: announcement.activity_name, period, back })}`,
      description: lines.join('\n'),
      footer: { text: describeSchedule(announcement) },
    }),
    winners,
  };
}
