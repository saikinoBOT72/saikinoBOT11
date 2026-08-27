import { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { deposit, getBalance, getSettings, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';

const SIDES = { heads: { label: '表', emoji: '🪙' }, tails: { label: '裏', emoji: '🌑' } };
const FLIP_DELAY_MS = 800;

export const data = new SlashCommandBuilder()
  .setName('coinflip')
  .setDescription('コイントス。当たれば賭け金が2倍になる')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('side')
      .setDescription('どちらに賭ける？')
      .setRequired(true)
      .addChoices({ name: '表', value: 'heads' }, { name: '裏', value: 'tails' }),
  )
  .addIntegerOption((o) => o.setName('bet').setDescription('賭け金').setRequired(true).setMinValue(1));

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const bet = interaction.options.getInteger('bet');
  const side = interaction.options.getString('side');

  const check = checkBet(guildId, interaction.user.id, bet, settings);
  if (!check.ok) {
    await interaction.reply({ content: check.message, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!withdraw(guildId, interaction.user.id, bet, 'coinflip:bet')) {
    await interaction.reply({ content: '残高が足りません。', flags: MessageFlags.Ephemeral });
    return;
  }

  const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = outcome === side;

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('🪙 コイントス').setDescription('コインが回転中…')],
  });
  await new Promise((resolve) => setTimeout(resolve, FLIP_DELAY_MS));

  if (won) deposit(guildId, interaction.user.id, bet * 2, 'coinflip:win');
  const balance = getBalance(guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(won ? 0x2ecc71 : 0x95a5a6)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('🪙 コイントス')
    .setDescription(
      `結果は **${SIDES[outcome].emoji} ${SIDES[outcome].label}**！\n` +
        (won ? `🎉 的中！ ${coins(bet * 2, settings)} を獲得しました。` : `外れ… ${coins(bet, settings)} を失いました。`),
    )
    .addFields(
      { name: '賭け', value: `${SIDES[side].label} / ${bet.toLocaleString('ja-JP')}`, inline: true },
      { name: '所持金', value: coins(balance, settings), inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}
