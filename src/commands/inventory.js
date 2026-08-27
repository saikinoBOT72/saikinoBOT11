import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { getSettings } from '../lib/economy.js';
import { inventoryOf, salesOf } from '../lib/shop.js';
import { coins, truncate } from '../lib/format.js';

export const data = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription('買ったアイテムと売れたアイテムを確認する')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('他の人の持ち物を見る場合に指定'));

export async function execute(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const settings = getSettings(interaction.guildId);
  const owned = inventoryOf(interaction.guildId, target.id);
  const sold = salesOf(interaction.guildId, target.id);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() })
    .setTitle('🎒 持ち物');

  if (owned.length === 0) {
    embed.setDescription('まだ何も持っていません。`/shop list` を覗いてみましょう。');
  } else {
    const spent = owned.reduce((sum, row) => sum + row.total, 0);
    embed.setDescription(
      owned
        .slice(0, 20)
        .map((row) => `• **${truncate(row.name, 40)}** ×${row.count}　*(#${row.item_id} / 計 ${settings.currency_emoji} ${row.total})*`)
        .join('\n'),
    );
    embed.addFields({ name: '購入合計', value: coins(spent, settings), inline: true });
  }

  if (sold.length > 0) {
    const revenue = sold.reduce((sum, row) => sum + row.total, 0);
    embed.addFields(
      { name: '売上合計', value: coins(revenue, settings), inline: true },
      {
        name: '売れたアイテム',
        value: sold
          .slice(0, 10)
          .map((row) => `• **${truncate(row.name, 40)}** ×${row.count}（${settings.currency_emoji} ${row.total}）`)
          .join('\n'),
      },
    );
  }

  embed.setFooter({ text: '画像は /shop show id:<番号> で見られます' });
  await interaction.reply({ embeds: [embed] });
}
