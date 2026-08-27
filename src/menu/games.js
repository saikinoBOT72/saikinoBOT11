import {
  EmbedBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { deposit, getBalance, getSettings, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { payoutTable, spin } from '../lib/slot.js';
import { startChallenge } from '../commands/rps.js';
import { amountRows, announce, backButton, button, homeButton, id, isError, readInt, row, show, toast } from './common.js';

/* ------------------------------------------------------------------ ゲーム選択 */

export async function open(interaction) {
  const settings = getSettings(interaction.guildId);
  const balance = getBalance(interaction.guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎮 あそぶ')
    .setDescription(`所持金 ${coins(balance, settings)}\n\n遊びたいものを選んでください。`)
    .addFields(
      { name: '🎰 スロット', value: '3つ揃いで最大 x3000', inline: true },
      { name: '🪙 コイントス', value: '当たれば2倍', inline: true },
      { name: '✊ じゃんけん', value: '勝てば相手の賭け金も総取り', inline: true },
    );

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('slot', 'open'), 'スロット', { emoji: '🎰', style: ButtonStyle.Primary }),
        button(id('cf', 'open'), 'コイントス', { emoji: '🪙', style: ButtonStyle.Primary }),
        button(id('rps', 'open'), 'じゃんけん', { emoji: '✊', style: ButtonStyle.Primary }),
      ),
      row(backButton()),
    ],
  });
}

export const games = { open };

/* ------------------------------------------------------------------ 共通 */

function amountModal(customId, title, label = '賭け金') {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 250')
          .setRequired(true)
          .setMaxLength(12),
      ),
    );
}

/** 賭け金が使えるか確認して、駄目ならその場でお知らせを出す。 */
async function ensureBet(interaction, amount) {
  const settings = getSettings(interaction.guildId);
  const check = checkBet(interaction.guildId, interaction.user.id, amount, settings);
  if (!check.ok) {
    await toast(interaction, check.message);
    return null;
  }
  return settings;
}

/* ------------------------------------------------------------------ スロット */

async function slotOpen(interaction) {
  const settings = getSettings(interaction.guildId);
  const balance = getBalance(interaction.guildId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎰 スロット')
    .setDescription(`所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。`)
    .addFields({ name: '配当', value: payoutTable(), inline: true })
    .setFooter({ text: '3つ揃いでも2つ揃い（🔔以上）でも配当があります' });

  return show(interaction, {
    embeds: [embed],
    components: [
      ...amountRows(['slot', 'bet'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
    ],
  });
}

async function slotCustom(interaction) {
  return interaction.showModal(amountModal(id('slot', 'amount'), 'スロット'));
}

async function slotAmount(interaction) {
  const amount = readInt(interaction, 'amount', { min: 1 });
  if (isError(amount)) return toast(interaction, amount.error);
  return slotSpin(interaction, amount);
}

async function slotBet(interaction, [amount]) {
  return slotSpin(interaction, Number(amount));
}

async function slotSpin(interaction, bet) {
  const settings = await ensureBet(interaction, bet);
  if (!settings) return undefined;
  if (!withdraw(interaction.guildId, interaction.user.id, bet, 'slot:bet')) {
    return toast(interaction, '残高が足りません。');
  }

  const result = spin();
  const payout = result.multiplier * bet;
  if (payout > 0) deposit(interaction.guildId, interaction.user.id, payout, 'slot:win', `x${result.multiplier}`);
  const balance = getBalance(interaction.guildId, interaction.user.id);
  const net = payout - bet;

  const embed = new EmbedBuilder()
    .setColor(payout > 0 ? 0x2ecc71 : 0x95a5a6)
    .setTitle('🎰 スロット')
    .setDescription(`# ${result.reels.join(' ｜ ')}\n${slotHeadline(result, payout, settings)}`)
    .addFields(
      { name: '賭け金', value: bet.toLocaleString('ja-JP'), inline: true },
      { name: '収支', value: `${net >= 0 ? '+' : ''}${net.toLocaleString('ja-JP')}`, inline: true },
      { name: '所持金', value: coins(balance, settings), inline: true },
    );

  if (result.kind === 'triple') {
    await announce(interaction, {
      embeds: [
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('🎉 大当たり！')
          .setDescription(
            `<@${interaction.user.id}> がスロットで **${result.symbol} 3つ揃い（x${result.multiplier}）**！\n${coins(payout, settings)} を獲得しました。`,
          ),
      ],
    });
  }

  const canRepeat = balance >= bet;
  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('slot', 'bet', String(bet)), `もう一度（${bet}）`, {
          emoji: '🔁',
          style: ButtonStyle.Success,
          disabled: !canRepeat,
        }),
        button(id('slot', 'open'), '賭け金を変える', { emoji: '💰' }),
        homeButton(),
      ),
    ],
  });
}

function slotHeadline(result, payout, settings) {
  if (result.kind === 'triple') return `🎉 **${result.symbol} 3つ揃い！ x${result.multiplier}** — ${coins(payout, settings)} 獲得！`;
  if (result.kind === 'double') return `✨ ${result.symbol} が2つ！ x${result.multiplier} — ${coins(payout, settings)} 獲得`;
  return '残念…もう一度どうぞ';
}

export const slot = { open: slotOpen, bet: slotBet, custom: slotCustom, amount: slotAmount };

/* ------------------------------------------------------------------ コイントス */

async function cfOpen(interaction) {
  const settings = getSettings(interaction.guildId);
  const balance = getBalance(interaction.guildId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🪙 コイントス')
    .setDescription(`所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。当たれば2倍、外れれば没収です。`);

  return show(interaction, {
    embeds: [embed],
    components: [...amountRows(['cf', 'bet'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] })],
  });
}

async function cfCustom(interaction) {
  return interaction.showModal(amountModal(id('cf', 'amount'), 'コイントス'));
}

async function cfAmount(interaction) {
  const amount = readInt(interaction, 'amount', { min: 1 });
  if (isError(amount)) return toast(interaction, amount.error);
  return cfSide(interaction, amount);
}

async function cfBet(interaction, [amount]) {
  return cfSide(interaction, Number(amount));
}

async function cfSide(interaction, bet) {
  const settings = await ensureBet(interaction, bet);
  if (!settings) return undefined;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🪙 コイントス')
    .setDescription(`賭け金は ${coins(bet, settings)}。\n**表か裏かを選んでください。**`);

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('cf', 'go', String(bet), 'heads'), '表', { emoji: '🪙', style: ButtonStyle.Primary }),
        button(id('cf', 'go', String(bet), 'tails'), '裏', { emoji: '🌑', style: ButtonStyle.Primary }),
      ),
      row(backButton('cf', '賭け金を変える'), homeButton()),
    ],
  });
}

const SIDES = { heads: { label: '表', emoji: '🪙' }, tails: { label: '裏', emoji: '🌑' } };

async function cfGo(interaction, [rawBet, side]) {
  const bet = Number(rawBet);
  const settings = await ensureBet(interaction, bet);
  if (!settings) return undefined;
  if (!withdraw(interaction.guildId, interaction.user.id, bet, 'coinflip:bet')) {
    return toast(interaction, '残高が足りません。');
  }

  const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = outcome === side;
  if (won) deposit(interaction.guildId, interaction.user.id, bet * 2, 'coinflip:win');
  const balance = getBalance(interaction.guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(won ? 0x2ecc71 : 0x95a5a6)
    .setTitle('🪙 コイントス')
    .setDescription(
      `結果は **${SIDES[outcome].emoji} ${SIDES[outcome].label}**！\n` +
        (won ? `🎉 的中！ ${coins(bet * 2, settings)} を獲得しました。` : `外れ… ${coins(bet, settings)} を失いました。`),
    )
    .addFields(
      { name: '賭け', value: `${SIDES[side].label} / ${bet.toLocaleString('ja-JP')}`, inline: true },
      { name: '所持金', value: coins(balance, settings), inline: true },
    );

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('cf', 'go', String(bet), side), `もう一度（${SIDES[side].label} ${bet}）`, {
          emoji: '🔁',
          style: ButtonStyle.Success,
          disabled: balance < bet,
        }),
        button(id('cf', 'open'), '賭け金を変える', { emoji: '💰' }),
        homeButton(),
      ),
    ],
  });
}

export const cf = { open: cfOpen, bet: cfBet, custom: cfCustom, amount: cfAmount, go: cfGo };

/* ------------------------------------------------------------------ じゃんけん */

async function rpsOpen(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✊✌️🖐️ じゃんけん')
    .setDescription('対戦したい相手を選んでください。\n相手が承諾すると勝負開始です。勝った方が賭け金を総取りします。');

  const select = new UserSelectMenuBuilder().setCustomId(id('rps', 'user')).setPlaceholder('対戦相手を選ぶ').setMaxValues(1);

  return show(interaction, { embeds: [embed], components: [row(select), row(backButton('games'), homeButton())] });
}

async function rpsUser(interaction) {
  const opponentId = interaction.values[0];
  if (opponentId === interaction.user.id) {
    await toast(interaction, '自分自身とは対戦できません。');
    return rpsOpen(interaction);
  }
  const opponent = await interaction.client.users.fetch(opponentId).catch(() => null);
  if (opponent?.bot) {
    await toast(interaction, 'Botとは対戦できません。');
    return rpsOpen(interaction);
  }
  return rpsBetScreen(interaction, opponentId);
}

async function rpsBetScreen(interaction, opponentId) {
  const settings = getSettings(interaction.guildId);
  const balance = getBalance(interaction.guildId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✊✌️🖐️ じゃんけん')
    .setDescription(`相手: <@${opponentId}>\n所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。`);

  const rows = amountRows(['rps', 'go', opponentId], balance, { maxBet: settings.max_bet });
  // 「金額を入力」は相手IDを引き継ぐ必要があるので2列目ごと差し替える
  rows[1] = row(
    button(id('rps', 'custom', opponentId), '金額を入力', { emoji: '⌨️' }),
    button(id('rps', 'go', opponentId, '0'), '賭けなし', { emoji: '🤝' }),
    backButton('rps', '相手を選び直す'),
  );
  return show(interaction, { embeds: [embed], components: rows });
}

async function rpsCustom(interaction, [opponentId]) {
  return interaction.showModal(amountModal(id('rps', 'amount', opponentId), 'じゃんけんの賭け金'));
}

async function rpsAmount(interaction, [opponentId]) {
  const amount = readInt(interaction, 'amount', { min: 0 });
  if (isError(amount)) return toast(interaction, amount.error);
  return rpsGo(interaction, [opponentId, String(amount)]);
}

async function rpsGo(interaction, [opponentId, rawBet]) {
  const bet = Number(rawBet);
  const settings = getSettings(interaction.guildId);

  if (bet > 0) {
    const check = checkBet(interaction.guildId, interaction.user.id, bet, settings);
    if (!check.ok) {
      await toast(interaction, check.message);
      return rpsBetScreen(interaction, opponentId);
    }
  }

  const opponent = await interaction.client.users.fetch(opponentId).catch(() => null);
  if (!opponent) return toast(interaction, '対戦相手が見つかりませんでした。');

  const sent = await startChallenge({
    channel: interaction.channel,
    guildId: interaction.guildId,
    challenger: interaction.user,
    opponent,
    bet,
  });
  if (!sent) return toast(interaction, 'このチャンネルに挑戦状を送れませんでした。');

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✊ 挑戦状を送りました')
    .setDescription(
      `<@${opponentId}> に勝負を申し込みました。\n` +
        (bet > 0 ? `賭け金 ${coins(bet, settings)}\n` : '') +
        '相手が「受けて立つ」を押すと勝負開始です。チャンネルのメッセージで手を選んでください。',
    );

  return show(interaction, { embeds: [embed], components: [row(button(id('rps', 'open'), 'もう一度挑戦', { emoji: '🔁' }), homeButton())] });
}

export const rps = { open: rpsOpen, user: rpsUser, custom: rpsCustom, amount: rpsAmount, go: rpsGo };
