import { canReport, countToday, logReport } from './activities.js';
import { deposit, getBalance } from './economy.js';
import { payStreakBonus, touchStreak } from './streak.js';
import { evaluate } from './achievements.js';
import { coins, duration, relative, truncate } from './format.js';
import { embed } from '../discord/builders.js';

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
export async function attemptReport(db, { guildId, userId, activity, timezone, note = null }) {
  const gate = await canReport(db, guildId, userId, activity, timezone);
  if (!gate.ok) return { ok: false, message: gateMessage(gate, activity) };

  await logReport(db, guildId, userId, activity.name, activity.reward, note);
  await deposit(db, guildId, userId, activity.reward, 'report', activity.name);

  const streak = await touchStreak(db, guildId, userId, timezone);
  const streakBonus = streak.isNewDay ? await payStreakBonus(db, guildId, userId, streak.current) : null;
  const unlocked = await evaluate(db, { guildId, userId, timezone });

  return {
    ok: true,
    balance: await getBalance(db, guildId, userId),
    count: await countToday(db, guildId, userId, activity.name, timezone),
    streak,
    streakBonus,
    unlocked,
  };
}

/** チャンネルに流す報告の見た目。 */
export function reportEmbed({ user, displayName, avatarUrl, activity, result, settings, note }) {
  const fields = [{ name: '所持金', value: coins(result.balance, settings), inline: true }];
  if (result.streak?.current > 0) {
    fields.push({ name: '連続日数', value: `🔥 **${result.streak.current}** 日`, inline: true });
  }
  if (activity.daily_limit > 0) {
    fields.push({ name: '今日の報告', value: `${result.count} / ${activity.daily_limit} 回`, inline: true });
  }
  if (note) fields.push({ name: 'ひとこと', value: truncate(note, 200) });

  const lines = [`${coins(activity.reward, settings)} を獲得しました`];
  if (result.streakBonus) {
    lines.push(`🔥 **${result.streakBonus.days}日連続ボーナス！** ${coins(result.streakBonus.reward, settings)} を追加で獲得`);
  }
  for (const unlocked of result.unlocked ?? []) {
    const bonus = unlocked.reward > 0 ? `（${coins(unlocked.reward, settings)}）` : '';
    lines.push(`🏅 称号 **${unlocked.emoji ?? ''}${unlocked.name}** を獲得！${bonus}`);
  }

  return embed({
    color: 0x2ecc71,
    author: { name: displayName ?? user.username, icon_url: avatarUrl },
    title: `${activity.emoji ?? '✅'} ${activity.name} 達成！`,
    description: lines.join('\n'),
    fields,
  });
}
