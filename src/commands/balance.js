import { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getBalance, getSettings, rankOf } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { getDb } from '../lib/db.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('所持金を確認する')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('他の人の所持金を見る場合に指定').setRequired(false));

export async function execute(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const balance = getBalance(guildId, target.id);
  const rank = rankOf(guildId, target.id);

  const db = getDb();
  const earned = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE guild_id = ? AND user_id = ? AND amount > 0')
    .get(guildId, target.id).total;
  const spent = db
    .prepare('SELECT COALESCE(SUM(-amount), 0) AS total FROM ledger WHERE guild_id = ? AND user_id = ? AND amount < 0')
    .get(guildId, target.id).total;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() })
    .setTitle('お財布')
    .setDescription(coins(balance, settings))
    .addFields(
      { name: 'サーバー順位', value: `**${rank}** 位`, inline: true },
      { name: '累計獲得', value: `${earned.toLocaleString('ja-JP')}`, inline: true },
      { name: '累計使用', value: `${spent.toLocaleString('ja-JP')}`, inline: true },
    );

  await interaction.reply({
    embeds: [embed],
    flags: target.id === interaction.user.id ? MessageFlags.Ephemeral : undefined,
  });
}
