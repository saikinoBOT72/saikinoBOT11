import { canReport, countToday, logReport } from './activities.js';
import { deposit } from './economy.js';
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
 * @returns {Promise<{ok: true, balance: number, count: number} | {ok: false, message: string}>}
 */
export async function attemptReport(db, { guildId, userId, activity, timezone, note = null }) {
  const gate = await canReport(db, guildId, userId, activity, timezone);
  if (!gate.ok) return { ok: false, message: gateMessage(gate, activity) };

  await logReport(db, guildId, userId, activity.name, activity.reward, note);
  const balance = await deposit(db, guildId, userId, activity.reward, 'report', activity.name);
  const count = await countToday(db, guildId, userId, activity.name, timezone);
  return { ok: true, balance, count };
}

/** チャンネルに流す報告の見た目。 */
export function reportEmbed({ user, displayName, avatarUrl, activity, result, settings, note }) {
  const fields = [{ name: '所持金', value: coins(result.balance, settings), inline: true }];
  if (activity.daily_limit > 0) {
    fields.push({ name: '今日の報告', value: `${result.count} / ${activity.daily_limit} 回`, inline: true });
  }
  if (note) fields.push({ name: 'ひとこと', value: truncate(note, 200) });

  return embed({
    color: 0x2ecc71,
    author: { name: displayName ?? user.username, icon_url: avatarUrl },
    title: `${activity.emoji ?? '✅'} ${activity.name} 達成！`,
    description: `${coins(activity.reward, settings)} を獲得しました`,
    fields,
  });
}
