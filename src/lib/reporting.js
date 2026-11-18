import { canReport, claimReport, countToday } from './activities.js';
import { ensureAccount, getBalance } from './economy.js';
import { payStreakBonus, touchStreak } from './streak.js';
import { dateKey, previousDay, startOfDay } from './calendar.js';
import { equippedTitle, evaluate, titleTag } from './achievements.js';
import { coins, duration, relative, truncate } from './format.js';
import { embed } from '../discord/builders.js';

/* ------------------------------------------------------ 報告メッセージの転送 */

/**
 * 「このチャンネルでした報告は、あっちに出す」という対応。
 *
 * 報告パネルを置いたチャンネルに「○○が報告しました」が流れ続けると、
 * パネルが上へ押し上げられて押しにくくなる。転送先を決めておけば、
 * パネルのチャンネルは静かなまま、みんな向けの報告は別の場所に集まる。
 */
export async function listRoutes(db, guildId) {
  return db.all(
    'SELECT * FROM report_routes WHERE guild_id = ?1 ORDER BY created_at ASC',
    guildId,
  );
}

export async function setRoute(db, guildId, fromChannelId, toChannelId) {
  await db.run(
    `INSERT INTO report_routes (guild_id, from_channel_id, to_channel_id, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(guild_id, from_channel_id) DO UPDATE SET to_channel_id = ?3`,
    guildId,
    fromChannelId,
    toChannelId,
    Date.now(),
  );
}

export async function removeRoute(db, guildId, fromChannelId) {
  const result = await db.run(
    'DELETE FROM report_routes WHERE guild_id = ?1 AND from_channel_id = ?2',
    guildId,
    fromChannelId,
  );
  return result.changes > 0;
}

/**
 * 報告メッセージを実際に出す先。
 * 転送先が決まっていなければ、報告したチャンネルをそのまま返す。
 */
export async function announceChannelFor(db, guildId, channelId) {
  if (!channelId) return channelId;
  const route = await db.get(
    'SELECT to_channel_id FROM report_routes WHERE guild_id = ?1 AND from_channel_id = ?2',
    guildId,
    channelId,
  );
  return route?.to_channel_id ?? channelId;
}

/** 報告できない理由を日本語にする。 */
export function gateMessage(gate, activity) {
  if (gate.reason === 'cooldown') {
    return `「${activity.name}」はまだ休憩中です。あと ${duration((gate.retryAtMs - Date.now()) / 1000)}（${relative(gate.retryAtMs)}）待ってください。`;
  }
  return `「${activity.name}」は1日 ${gate.limit} 回までです。日付が変わるまで待ってください。`;
}

/**
 * 報告を確定してコインを渡す。
 * あわせて連続日数を進め、連日ボーナスと称号の獲得も処理する。
 * ok が false なら message に理由。true なら残りが入る。
 * @returns {Promise<{ok: boolean, message?: string, logId?: number|null, balance?: number, count?: number,
 *   streak?: any, streakBonus?: {days: number, reward: number}|null, unlocked?: any[], title?: any,
 *   week?: boolean[], total?: number, nextBonus?: any}>}
 */
export async function attemptReport(db, { guildId, userId, activity, calendar, note = null }) {
  const gate = await canReport(db, guildId, userId, activity, calendar);
  if (!gate.ok) return { ok: false, message: gateMessage(gate, activity) };

  // 記録とコインは1つの処理で。同時に押されたぶんはここで弾かれる
  await ensureAccount(db, guildId, userId);
  const now = Date.now();
  if (!(await claimReport(db, guildId, userId, activity, calendar, note, now))) {
    const again = await canReport(db, guildId, userId, activity, calendar);
    return { ok: false, message: again.ok ? 'いま混み合っています。もう一度押してください。' : gateMessage(again, activity) };
  }
  const log = await db.get(
    'SELECT id FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at = ?4 ORDER BY id DESC LIMIT 1',
    guildId,
    userId,
    activity.name,
    now,
  );

  // 連続記録はアクションごとに数える
  const streak = await touchStreak(db, guildId, userId, activity.name, calendar);
  const streakBonus = streak.isNewDay
    ? await payStreakBonus(db, guildId, userId, activity.name, streak.current)
    : null;

  // 取り消すときに戻せるよう、出たボーナスと進める前の連続記録を控えておく
  if (log) {
    await db.run(
      'UPDATE activity_logs SET bonus = ?2, streak_before = ?3 WHERE id = ?1',
      log.id,
      streakBonus?.reward ?? 0,
      streak.isNewDay ? JSON.stringify(streak.before ?? null) : null,
    );
  }

  const unlocked = await evaluate(db, { guildId, userId, calendar });
  const title = await equippedTitle(db, guildId, userId);
  const [week, total, nextBonus] = await Promise.all([
    weekOf(db, guildId, userId, activity.name, calendar, now),
    totalOf(db, guildId, userId, activity.name),
    nextStreakBonus(db, guildId, activity.name, streak.current),
  ]);

  return {
    ok: true,
    logId: log?.id ?? null,
    balance: await getBalance(db, guildId, userId),
    count: await countToday(db, guildId, userId, activity.name, calendar),
    streak,
    streakBonus,
    unlocked,
    title,
    week,
    total,
    nextBonus,
  };
}

/* ------------------------------------------------------ 7日のカレンダーと節目 */

/** 直近7日（古い順、最後が今日）に、そのアクションを報告した日かどうか。 */
export async function weekOf(db, guildId, userId, activity, calendar, now = Date.now()) {
  const keys = [dateKey(calendar, new Date(now))];
  while (keys.length < 7) keys.unshift(previousDay(keys[0]));
  const since = startOfDay(calendar, new Date(now - 6 * 24 * 3600 * 1000));
  const rows = await db.all(
    'SELECT created_at FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at >= ?4',
    guildId,
    userId,
    activity,
    since,
  );
  const done = new Set(rows.map((row) => dateKey(calendar, new Date(row.created_at))));
  return keys.map((key) => done.has(key));
}

async function totalOf(db, guildId, userId, activity) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
    guildId,
    userId,
    activity,
  );
  return row?.n ?? 0;
}

/** まだ届いていない、いちばん近い連日ボーナス。 */
async function nextStreakBonus(db, guildId, activity, current) {
  return db.get(
    'SELECT from_days, reward FROM streak_rewards WHERE guild_id = ?1 AND activity = ?2 AND from_days > ?3 AND reward > 0 ORDER BY from_days ASC LIMIT 1',
    guildId,
    activity,
    current,
  );
}

/** 通算の回数で祝う節目。 */
export const MILESTONES = [10, 30, 50, 100, 200, 300, 365, 500, 1000, 2000, 3000, 5000, 10000];

/** 7日ぶんを ■□ の並びに。 */
export function weekLine(week) {
  return week.map((done) => (done ? '🟩' : '⬜')).join('');
}

/* ------------------------------------------------------ 報告の取り消し */

/** 報告を取り消せる時間。押し間違いに気づくには十分で、ランキングを荒らすには短い。 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/** チャンネルに出た報告の場所を控える（取り消したら消すため）。 */
export async function rememberPost(db, logId, channelId, messageId) {
  if (!logId || !messageId) return;
  await db.run('UPDATE activity_logs SET post_channel_id = ?2, post_message_id = ?3 WHERE id = ?1', logId, channelId, messageId);
}

/**
 * 報告を取り消す。もらったコイン（連日ボーナスも）を戻し、連続記録も報告前に戻す。
 * 称号はそのまま（一度もらったものは同じ条件でもう一度もらえないので、取り消しても増えない）。
 *
 * 【同時押し】最初の文で「取り消し中」の印を付ける（コインが足りているときだけ）。
 * 残りの文はすべて「印が付いている」ことを条件にし、最後に記録ごと消す。
 * 2回押されても、印を付けられるのは1回だけ。
 * @returns {Promise<{ok: boolean, log?: any, total?: number, message?: string}>}
 */
export async function undoReport(db, guildId, userId, logId, now = Date.now()) {
  const log = await db.get(
    'SELECT * FROM activity_logs WHERE id = ?1 AND guild_id = ?2 AND user_id = ?3',
    logId,
    guildId,
    userId,
  );
  if (!log) return { ok: false, message: 'その報告はもう取り消してあるか、見つかりませんでした。' };
  if (now - log.created_at > UNDO_WINDOW_MS) return { ok: false, message: '取り消せるのは、報告してから5分以内です。' };
  const later = await db.get(
    'SELECT 1 AS found FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND id > ?4 LIMIT 1',
    guildId,
    userId,
    log.activity,
    log.id,
  );
  if (later) return { ok: false, message: 'このあとにも同じアクションを報告しています。取り消せるのは最後の1回だけです。' };

  const total = log.reward + log.bonus;
  const CLAIMED = 'EXISTS (SELECT 1 FROM activity_logs WHERE id = ?1 AND undoing = 1)';
  const statements = [
    [
      `UPDATE activity_logs SET undoing = 1
        WHERE id = ?1 AND undoing = 0
          AND COALESCE((SELECT balance FROM balances WHERE guild_id = ?2 AND user_id = ?3), 0) >= ?4`,
      log.id, guildId, userId, total,
    ],
  ];
  if (total > 0) {
    statements.push(
      [
        `INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)
         SELECT ?2, ?3, -?4, 'report:undo', ?5, ?6 WHERE ${CLAIMED}`,
        log.id, guildId, userId, total, log.activity, now,
      ],
      [`UPDATE balances SET balance = balance - ?4 WHERE guild_id = ?2 AND user_id = ?3 AND ${CLAIMED}`, log.id, guildId, userId, total],
    );
  }
  if (log.streak_before != null) {
    const before = JSON.parse(log.streak_before);
    statements.push(
      before
        ? [
            `UPDATE streaks SET current = ?5, best = ?6, last_date = ?7
              WHERE guild_id = ?2 AND user_id = ?3 AND activity = ?4 AND ${CLAIMED}`,
            log.id, guildId, userId, log.activity, before.current, before.best, before.last_date,
          ]
        : [`DELETE FROM streaks WHERE guild_id = ?2 AND user_id = ?3 AND activity = ?4 AND ${CLAIMED}`, log.id, guildId, userId, log.activity],
    );
  }
  statements.push(['DELETE FROM activity_logs WHERE id = ?1 AND undoing = 1', log.id]);

  const results = await db.batch(statements);
  if (results[0].changes !== 1) {
    const still = await db.get('SELECT 1 AS found FROM activity_logs WHERE id = ?1', log.id);
    return {
      ok: false,
      message: still
        ? `この報告でもらったコイン（${total}）を、もう使ってしまったため取り消せません。`
        : 'その報告はもう取り消してあります。',
    };
  }
  return { ok: true, log, total };
}

/** チャンネルに流す報告の見た目。 */
/** @param {{user: any, displayName?: string, avatarUrl?: string, activity: any, result: any, settings: any, note?: string}} parts */
export function reportEmbed({ user, displayName, avatarUrl, activity, result, settings, note }) {
  /** @type {Array<{name: string, value: string, inline?: boolean}>} */
  const fields = [{ name: '所持金', value: coins(result.balance, settings), inline: true }];
  if (result.streak?.current > 0) {
    fields.push({ name: `${activity.name} の連続`, value: `🔥 **${result.streak.current}** 日`, inline: true });
  }
  if (activity.daily_limit > 0) {
    fields.push({ name: '今日の報告', value: `${result.count} / ${activity.daily_limit} 回`, inline: true });
  }
  if (result.week) {
    const days = result.week.filter(Boolean).length;
    fields.push({ name: 'この7日', value: `${weekLine(result.week)}　${days}/7 日`, inline: false });
  }
  if (note) fields.push({ name: 'ひとこと', value: truncate(note, 200) });

  const lines = [`${coins(activity.reward, settings)} を獲得しました`];
  if (result.streakBonus) {
    lines.push(
      `🔥 **${activity.name} ${result.streakBonus.days}日連続ボーナス！** ${coins(result.streakBonus.reward, settings)} を追加で獲得`,
    );
  }
  for (const unlocked of result.unlocked ?? []) {
    const bonus = unlocked.reward > 0 ? `（${coins(unlocked.reward, settings)}）` : '';
    lines.push(`🏅 称号 **${unlocked.emoji ?? ''}${unlocked.name}** を獲得！${bonus}`);
  }
  if (MILESTONES.includes(result.total)) lines.push(`🎉 **${activity.name} 通算 ${result.total} 回目！**`);
  if (result.nextBonus && result.streak?.current > 0) {
    const left = result.nextBonus.from_days - result.streak.current;
    lines.push(`*あと ${left} 日続けると ${result.nextBonus.from_days}日連続ボーナス（${coins(result.nextBonus.reward, settings)}）*`);
  }

  const tag = titleTag(result.title);
  return embed({
    color: 0x2ecc71,
    author: { name: `${tag ? `【${tag}】` : ''}${displayName ?? user.username}`, icon_url: avatarUrl },
    title: `${activity.emoji ?? '✅'} ${activity.name} 達成！`,
    description: lines.join('\n'),
    fields,
  });
}
