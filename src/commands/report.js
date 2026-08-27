import { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getSettings, deposit } from '../lib/economy.js';
import { canReport, countToday, getActivity, listActivities, logReport, reportStats } from '../lib/activities.js';
import { coins, duration, relative, truncate } from '../lib/format.js';

export const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('アクションを報告してコインをもらう')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('do')
      .setDescription('報告する（例: 筋トレ）')
      .addStringOption((o) =>
        o.setName('activity').setDescription('報告するアクション').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) => o.setName('note').setDescription('ひとこと（任意）').setMaxLength(200))
      .addAttachmentOption((o) => o.setName('proof').setDescription('証拠の画像（任意／必須のアクションもあり）')),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('報告できるアクションの一覧を見る'))
  .addSubcommand((sub) =>
    sub
      .setName('stats')
      .setDescription('これまでの報告実績を見る')
      .addUserOption((o) => o.setName('user').setDescription('他の人の実績を見る場合に指定')),
  );

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = listActivities(interaction.guildId)
    .filter((a) => a.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((a) => ({ name: `${a.emoji ?? '•'} ${a.name}（+${a.reward}）`, value: a.name }));
  await interaction.respond(choices);
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') return handleList(interaction);
  if (sub === 'stats') return handleStats(interaction);
  return handleReport(interaction);
}

async function handleReport(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const name = interaction.options.getString('activity');
  const note = interaction.options.getString('note');
  const proof = interaction.options.getAttachment('proof');

  const activity = getActivity(guildId, name);
  if (!activity) {
    await interaction.reply({
      content: `「${truncate(name, 50)}」というアクションは登録されていません。\`/report list\` で一覧を確認できます。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (proof && !(proof.contentType ?? '').startsWith('image/')) {
    await interaction.reply({ content: '証拠は画像ファイルを添付してください。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (activity.need_proof && !proof) {
    await interaction.reply({
      content: `「${activity.name}」の報告には画像の添付が必要です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const gate = canReport(guildId, interaction.user.id, activity);
  if (!gate.ok) {
    const message =
      gate.reason === 'cooldown'
        ? `「${activity.name}」はまだクールダウン中です。あと ${duration((gate.retryAtMs - Date.now()) / 1000)}（${relative(gate.retryAtMs)}）待ってください。`
        : `「${activity.name}」は1日 ${gate.limit} 回までです。日付が変わるまで待ってください。`;
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  logReport(guildId, interaction.user.id, activity.name, activity.reward, note);
  const balance = deposit(guildId, interaction.user.id, activity.reward, 'report', activity.name);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle(`${activity.emoji ?? '✅'} ${activity.name} 達成！`)
    .setDescription(`${coins(activity.reward, settings)} を獲得しました`)
    .addFields({ name: '所持金', value: coins(balance, settings), inline: true });

  if (activity.daily_limit > 0) {
    embed.addFields({
      name: '今日の報告',
      value: `${countToday(guildId, interaction.user.id, activity.name)} / ${activity.daily_limit} 回`,
      inline: true,
    });
  }
  if (note) embed.addFields({ name: 'ひとこと', value: truncate(note, 200) });
  if (proof) embed.setImage(proof.url);

  await interaction.reply({ embeds: [embed] });
}

async function handleList(interaction) {
  const settings = getSettings(interaction.guildId);
  const activities = listActivities(interaction.guildId);

  if (activities.length === 0) {
    await interaction.reply({
      content:
        'まだアクションが登録されていません。サーバー管理者が `/activity preset` でおすすめ設定を入れるか、`/activity add` で追加してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = activities.map((a) => {
    const limits = [];
    if (a.cooldown_sec > 0) limits.push(`CD ${duration(a.cooldown_sec)}`);
    if (a.daily_limit > 0) limits.push(`1日${a.daily_limit}回まで`);
    if (a.need_proof) limits.push('画像必須');
    const meta = limits.length > 0 ? `　*(${limits.join(' / ')})*` : '';
    const desc = a.description ? `\n　　${truncate(a.description, 80)}` : '';
    return `${a.emoji ?? '•'} **${a.name}** — ${settings.currency_emoji} ${a.reward}${meta}${desc}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📋 報告できるアクション')
    .setDescription(lines.join('\n'))
    .setFooter({ text: '/report do activity:<名前> で報告できます' });

  await interaction.reply({ embeds: [embed] });
}

async function handleStats(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const settings = getSettings(interaction.guildId);
  const stats = reportStats(interaction.guildId, target.id);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() })
    .setTitle('📈 報告実績')
    .setDescription(
      `報告回数 **${stats.total.n}** 回／獲得 ${coins(stats.total.sum, settings)}`,
    );

  if (stats.byActivity.length > 0) {
    embed.addFields({
      name: '内訳',
      value: stats.byActivity.map((r) => `• **${r.activity}** ${r.n} 回（${settings.currency_emoji} ${r.sum}）`).join('\n'),
    });
  }

  await interaction.reply({ embeds: [embed] });
}
