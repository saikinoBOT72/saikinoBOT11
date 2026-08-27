import { EmbedBuilder } from 'discord.js';
import { canReport, countToday, logReport } from './activities.js';
import { deposit, getSettings } from './economy.js';
import { coins, duration, relative, truncate } from './format.js';

/** 報告できない理由を日本語にする。 */
export function gateMessage(gate, activity) {
  if (gate.reason === 'cooldown') {
    return `「${activity.name}」はまだクールダウン中です。あと ${duration((gate.retryAtMs - Date.now()) / 1000)}（${relative(gate.retryAtMs)}）待ってください。`;
  }
  return `「${activity.name}」は1日 ${gate.limit} 回までです。日付が変わるまで待ってください。`;
}

/**
 * 報告を確定してコインを渡す。
 * @returns {{ok: true, balance: number, count: number} | {ok: false, message: string}}
 */
export function attemptReport({ guildId, userId, activity, note = null }) {
  const gate = canReport(guildId, userId, activity);
  if (!gate.ok) return { ok: false, message: gateMessage(gate, activity) };

  logReport(guildId, userId, activity.name, activity.reward, note);
  const balance = deposit(guildId, userId, activity.reward, 'report', activity.name);
  return { ok: true, balance, count: countToday(guildId, userId, activity.name) };
}

/** 報告完了の Embed。コマンドからもメニューからも同じ見た目にする。 */
export function reportEmbed({ guildId, user, displayName, activity, result, note, imageUrl }) {
  const settings = getSettings(guildId);
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: displayName ?? user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`${activity.emoji ?? '✅'} ${activity.name} 達成！`)
    .setDescription(`${coins(activity.reward, settings)} を獲得しました`)
    .addFields({ name: '所持金', value: coins(result.balance, settings), inline: true });

  if (activity.daily_limit > 0) {
    embed.addFields({ name: '今日の報告', value: `${result.count} / ${activity.daily_limit} 回`, inline: true });
  }
  if (note) embed.addFields({ name: 'ひとこと', value: truncate(note, 200) });
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}
