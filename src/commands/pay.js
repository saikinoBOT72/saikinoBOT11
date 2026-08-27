import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getSettings, transfer, getBalance } from '../lib/economy.js';
import { coins } from '../lib/format.js';

export const data = new SlashCommandBuilder()
  .setName('pay')
  .setDescription('他のメンバーに送金する')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('送る相手').setRequired(true))
  .addIntegerOption((o) => o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1))
  .addStringOption((o) => o.setName('memo').setDescription('メモ（任意）').setMaxLength(100));

export async function execute(interaction) {
  const target = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const memo = interaction.options.getString('memo');
  const settings = getSettings(interaction.guildId);

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: '自分自身には送金できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot) {
    await interaction.reply({ content: 'Botには送金できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  const ok = transfer(interaction.guildId, interaction.user.id, target.id, amount, 'pay', memo);
  if (!ok) {
    const balance = getBalance(interaction.guildId, interaction.user.id);
    await interaction.reply({
      content: `残高が足りません。現在の所持金は ${coins(balance, settings)} です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const memoText = memo ? `\n> ${memo}` : '';
  await interaction.reply(
    `💸 <@${interaction.user.id}> → <@${target.id}> に ${coins(amount, settings)} を送金しました。${memoText}`,
  );
}
