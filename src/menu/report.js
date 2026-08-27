import { EmbedBuilder, StringSelectMenuBuilder, ButtonStyle } from 'discord.js';
import { canReport, getActivity, listActivities, reportStats } from '../lib/activities.js';
import { attemptReport, gateMessage, reportEmbed } from '../lib/reporting.js';
import { getSettings } from '../lib/economy.js';
import { coins, duration, truncate } from '../lib/format.js';
import { imagePayload } from '../lib/images.js';
import { announce, backButton, button, homeButton, id, row, show, toast } from './common.js';
import { awaitImage, uploadHint } from './upload.js';

export async function open(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const activities = listActivities(guildId);

  if (activities.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💪 報告してかせぐ')
      .setDescription(
        'まだアクションが登録されていません。\nサーバー管理者が **⚙️ 管理 → アクション管理 → おすすめを一括登録** すればすぐ始められます。',
      );
    return show(interaction, { embeds: [embed], components: [row(backButton())] });
  }

  const lines = [];
  const options = [];
  for (const activity of activities.slice(0, 25)) {
    const gate = canReport(guildId, interaction.user.id, activity);
    const limits = [];
    if (activity.cooldown_sec > 0) limits.push(`${duration(activity.cooldown_sec)}おき`);
    if (activity.daily_limit > 0) limits.push(`1日${activity.daily_limit}回`);
    if (activity.need_proof) limits.push('写真必須');
    const status = gate.ok ? '' : gate.reason === 'cooldown' ? '　⏳休憩中' : '　✅今日は達成済み';
    lines.push(
      `${activity.emoji ?? '•'} **${activity.name}** ＋${settings.currency_emoji}${activity.reward}` +
        (limits.length > 0 ? `　*(${limits.join(' / ')})*` : '') +
        status,
    );
    options.push({
      label: truncate(`${activity.name}（+${activity.reward}）`, 100),
      value: activity.name,
      emoji: activity.emoji ?? undefined,
      description: truncate(describeOption(activity, gate, limits), 100),
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('💪 報告してかせぐ')
    .setDescription(lines.join('\n'))
    .setFooter({ text: '下のリストから選ぶだけで報告できます' });

  const select = new StringSelectMenuBuilder()
    .setCustomId(id('report', 'pick'))
    .setPlaceholder('報告するアクションを選ぶ')
    .addOptions(options);

  return show(interaction, {
    embeds: [embed],
    components: [row(select), row(backButton(), button(id('report', 'stats'), '実績を見る', { emoji: '📈' }))],
  });
}

function describeOption(activity, gate, limits) {
  if (!gate.ok) return gate.reason === 'cooldown' ? '休憩中' : '今日はもう達成済み';
  if (activity.description) return activity.description;
  return limits.length > 0 ? limits.join(' / ') : '報告できます';
}

export async function pick(interaction) {
  const guildId = interaction.guildId;
  const name = interaction.values[0];
  const activity = getActivity(guildId, name);
  if (!activity) return toast(interaction, 'そのアクションは削除されたようです。');

  const gate = canReport(guildId, interaction.user.id, activity);
  if (!gate.ok) {
    await toast(interaction, gateMessage(gate, activity));
    return open(interaction);
  }

  if (activity.need_proof) return waitForPhoto(interaction, activity);
  return complete(interaction, activity, null, null);
}

/** 写真必須のアクション。画像が届くまで待つ。 */
async function waitForPhoto(interaction, activity) {
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`${activity.emoji ?? '📷'} ${activity.name} の報告`)
    .setDescription(`このアクションは写真が必要です。\n${uploadHint(interaction.client)}\n\n*3分以内に送ってください。*`);
  await show(interaction, { embeds: [embed], components: [] });

  const uploaded = await awaitImage(interaction);
  if (uploaded.error) {
    await show(interaction, {
      embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('報告できませんでした').setDescription(uploaded.error)],
      components: [row(button(id('report', 'open'), 'もう一度', { emoji: '🔁' }), homeButton())],
    });
    return undefined;
  }
  return complete(interaction, activity, uploaded.file, uploaded.attachment.url);
}

async function complete(interaction, activity, imageFile, imageUrl) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const result = attemptReport({ guildId, userId: interaction.user.id, activity });

  if (!result.ok) {
    await toast(interaction, result.message);
    return open(interaction);
  }

  const embed = reportEmbed({
    guildId,
    user: interaction.user,
    displayName: interaction.member?.displayName,
    activity,
    result,
    note: null,
    imageUrl: imageFile ? `attachment://${imageFile}` : imageUrl,
  });
  const { files } = imageFile ? imagePayload({ image_file: imageFile }) : { files: [] };
  await announce(interaction, { embeds: [embed], files });

  const done = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${activity.emoji ?? '✅'} ${activity.name} を報告しました`)
    .setDescription(`${coins(activity.reward, settings)} を獲得！\n所持金は ${coins(result.balance, settings)} です。`)
    .setFooter({ text: 'みんなに見えるように報告をチャンネルにも投稿しました' });

  return show(interaction, {
    embeds: [done],
    components: [row(button(id('report', 'open'), '続けて報告', { emoji: '💪', style: ButtonStyle.Success }), homeButton())],
  });
}

export async function stats(interaction) {
  const settings = getSettings(interaction.guildId);
  const data = reportStats(interaction.guildId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('📈 報告の実績')
    .setDescription(`報告回数 **${data.total.n}** 回／獲得 ${coins(data.total.sum, settings)}`);

  if (data.byActivity.length > 0) {
    embed.addFields({
      name: '内訳',
      value: data.byActivity.map((r) => `• **${r.activity}** ${r.n} 回（${settings.currency_emoji} ${r.sum}）`).join('\n'),
    });
  }

  return show(interaction, { embeds: [embed], components: [row(backButton('report'), homeButton())] });
}

export const actions = { open, pick, stats };
