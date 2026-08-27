import { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { deposit, getSettings, withdraw, getBalance } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { payoutTable, spin } from '../lib/slot.js';

const SPIN_DELAY_MS = 900;

export const data = new SlashCommandBuilder()
  .setName('slot')
  .setDescription('スロットを回す')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('play')
      .setDescription('コインを賭けてスロットを回す')
      .addIntegerOption((o) => o.setName('bet').setDescription('賭け金').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) => sub.setName('table').setDescription('配当表を見る'));

export async function execute(interaction) {
  if (interaction.options.getSubcommand() === 'table') return showTable(interaction);
  return play(interaction);
}

async function showTable(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎰 スロット配当表')
    .setDescription(payoutTable())
    .setFooter({ text: '配当は賭け金 × 倍率。還元率はおよそ 91%' });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function play(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const bet = interaction.options.getInteger('bet');

  const check = checkBet(guildId, interaction.user.id, bet, settings);
  if (!check.ok) {
    await interaction.reply({ content: check.message, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!withdraw(guildId, interaction.user.id, bet, 'slot:bet')) {
    await interaction.reply({ content: '残高が足りません。', flags: MessageFlags.Ephemeral });
    return;
  }

  const result = spin();
  const spinning = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎰 スロット')
    .setDescription('```\n[ 🎲 | 🎲 | 🎲 ]\n```\n回転中…')
    .setFooter({ text: `賭け金 ${bet}` });
  await interaction.reply({ embeds: [spinning] });

  await new Promise((resolve) => setTimeout(resolve, SPIN_DELAY_MS));

  const payout = result.multiplier * bet;
  if (payout > 0) deposit(guildId, interaction.user.id, payout, 'slot:win', `x${result.multiplier}`);
  const balance = getBalance(guildId, interaction.user.id);
  const net = payout - bet;

  const embed = new EmbedBuilder()
    .setColor(payout > 0 ? 0x2ecc71 : 0x95a5a6)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('🎰 スロット')
    .setDescription(`# ${result.reels.join(' ｜ ')}\n${headline(result, payout, settings)}`)
    .addFields(
      { name: '収支', value: `${net >= 0 ? '+' : ''}${net.toLocaleString('ja-JP')}`, inline: true },
      { name: '所持金', value: coins(balance, settings), inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}

function headline(result, payout, settings) {
  if (result.kind === 'triple') return `🎉 **${result.symbol} 3つ揃い！ x${result.multiplier}** — ${coins(payout, settings)} 獲得！`;
  if (result.kind === 'double') return `✨ ${result.symbol} が2つ！ x${result.multiplier} — ${coins(payout, settings)} 獲得`;
  return '残念…また挑戦してね';
}
