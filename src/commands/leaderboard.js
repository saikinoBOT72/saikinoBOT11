import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { getSettings, topBalances } from '../lib/economy.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('所持金ランキングを表示する')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) => o.setName('count').setDescription('表示人数（初期値10）').setMinValue(1).setMaxValue(25));

export async function execute(interaction) {
  const settings = getSettings(interaction.guildId);
  const limit = interaction.options.getInteger('count') ?? 10;
  const rows = topBalances(interaction.guildId, limit);

  if (rows.length === 0) {
    await interaction.reply('まだ誰も口座を持っていません。');
    return;
  }

  const lines = rows.map((row, i) => {
    const rank = MEDALS[i] ?? `**${i + 1}.**`;
    return `${rank} <@${row.user_id}> — ${settings.currency_emoji} ${row.balance.toLocaleString('ja-JP')}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`💰 ${settings.currency_name}ランキング`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${interaction.guild.name}` });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
