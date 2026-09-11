import { canReport, countToday, logReport } from './activities.js';
import { deposit, getBalance } from './economy.js';
import { payStreakBonus, touchStreak } from './streak.js';
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
 * @returns {Promise<{ok: true, balance: number, count: number, streak: object,
 *   streakBonus: {days: number, reward: number}|null, unlocked: object[]} | {ok: false, message: string}>}
 */
export async function attemptReport(db, { guildId, userId, activity, calendar, note = null }) {
  const gate = await canReport(db, guildId, userId, activity, calendar);
  if (!gate.ok) return { ok: false, message: gateMessage(gate, activity) };

  await logReport(db, guildId, userId, activity.name, activity.reward, note);
  await deposit(db, guildId, userId, activity.reward, 'report', activity.name);

  // 連続記録はアクションごとに数える
  const streak = await touchStreak(db, guildId, userId, activity.name, calendar);
  const streakBonus = streak.isNewDay
    ? await payStreakBonus(db, guildId, userId, activity.name, streak.current)
    : null;
  const unlocked = await evaluate(db, { guildId, userId, calendar });
  const title = await equippedTitle(db, guildId, userId);

  return {
    ok: true,
    balance: await getBalance(db, guildId, userId),
    count: await countToday(db, guildId, userId, activity.name, calendar),
    streak,
    streakBonus,
    unlocked,
    title,
  };
}

/** チャンネルに流す報告の見た目。 */
export function reportEmbed({ user, displayName, avatarUrl, activity, result, settings, note }) {
  const fields = [{ name: '所持金', value: coins(result.balance, settings), inline: true }];
  if (result.streak?.current > 0) {
    fields.push({ name: `${activity.name} の連続`, value: `🔥 **${result.streak.current}** 日`, inline: true });
  }
  if (activity.daily_limit > 0) {
    fields.push({ name: '今日の報告', value: `${result.count} / ${activity.daily_limit} 回`, inline: true });
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

  const tag = titleTag(result.title);
  return embed({
    color: 0x2ecc71,
    author: { name: `${tag ? `【${tag}】` : ''}${displayName ?? user.username}`, icon_url: avatarUrl },
    title: `${activity.emoji ?? '✅'} ${activity.name} 達成！`,
    description: lines.join('\n'),
    fields,
  });
}
