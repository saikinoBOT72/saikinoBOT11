import {
  EmbedBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getBalance, getSettings, rankOf, topBalances, transfer } from '../lib/economy.js';
import { getDb } from '../lib/db.js';
import { coins } from '../lib/format.js';
import { announce, backButton, button, homeButton, id, isError, readInt, readText, row, show, toast } from './common.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export async function open(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const balance = getBalance(guildId, interaction.user.id);
  const db = getDb();
  const earned = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE guild_id = ? AND user_id = ? AND amount > 0')
    .get(guildId, interaction.user.id).total;
  const spent = db
    .prepare('SELECT COALESCE(SUM(-amount), 0) AS total FROM ledger WHERE guild_id = ? AND user_id = ? AND amount < 0')
    .get(guildId, interaction.user.id).total;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('💰 お財布')
    .setDescription(coins(balance, settings))
    .addFields(
      { name: 'サーバー順位', value: `**${rankOf(guildId, interaction.user.id)}** 位`, inline: true },
      { name: '累計獲得', value: earned.toLocaleString('ja-JP'), inline: true },
      { name: '累計使用', value: spent.toLocaleString('ja-JP'), inline: true },
    );

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('wallet', 'pay'), '送金する', { emoji: '💸', style: ButtonStyle.Primary }),
        button(id('wallet', 'history'), '履歴', { emoji: '📜' }),
        button(id('wallet', 'rank'), 'ランキング', { emoji: '🏆' }),
      ),
      row(backButton()),
    ],
  });
}

export async function pay(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('💸 送金')
    .setDescription('送りたい相手を選んでください。');
  const select = new UserSelectMenuBuilder().setCustomId(id('wallet', 'payto')).setPlaceholder('送る相手を選ぶ').setMaxValues(1);
  return show(interaction, { embeds: [embed], components: [row(select), row(backButton('wallet'), homeButton())] });
}

export async function payto(interaction) {
  const targetId = interaction.values[0];
  if (targetId === interaction.user.id) {
    await toast(interaction, '自分自身には送金できません。');
    return pay(interaction);
  }
  const target = await interaction.client.users.fetch(targetId).catch(() => null);
  if (target?.bot) {
    await toast(interaction, 'Botには送金できません。');
    return pay(interaction);
  }

  const modal = new ModalBuilder()
    .setCustomId(id('wallet', 'paydo', targetId))
    .setTitle(`${target?.username ?? 'メンバー'} に送金`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('amount').setLabel('金額').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('memo').setLabel('メモ（任意）').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ),
    );
  return interaction.showModal(modal);
}

export async function paydo(interaction, [targetId]) {
  const settings = getSettings(interaction.guildId);
  const amount = readInt(interaction, 'amount', { min: 1 });
  if (isError(amount)) return toast(interaction, amount.error);
  const memo = readText(interaction, 'memo');

  const ok = transfer(interaction.guildId, interaction.user.id, targetId, amount, 'pay', memo);
  if (!ok) {
    await toast(interaction, `残高が足りません。現在の所持金は ${coins(getBalance(interaction.guildId, interaction.user.id), settings)} です。`);
    return open(interaction);
  }

  await announce(interaction, {
    content: `💸 <@${interaction.user.id}> → <@${targetId}> に ${coins(amount, settings)} を送金しました。${memo ? `\n> ${memo}` : ''}`,
    allowedMentions: { users: [targetId] },
  });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ 送金しました')
    .setDescription(`<@${targetId}> に ${coins(amount, settings)} を送りました。\n残りは ${coins(getBalance(interaction.guildId, interaction.user.id), settings)} です。`);
  return show(interaction, { embeds: [embed], components: [row(backButton('wallet'), homeButton())] });
}

export async function history(interaction) {
  const rows = getDb()
    .prepare('SELECT * FROM ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15')
    .all(interaction.guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('📜 コインの履歴')
    .setDescription(
      rows.length === 0
        ? 'まだ履歴がありません。'
        : rows
            .map((r) => {
              const sign = r.amount >= 0 ? '+' : '';
              return `<t:${Math.floor(r.created_at / 1000)}:R>　\`${sign}${r.amount}\`　${reasonLabel(r)}`;
            })
            .join('\n'),
    );
  return show(interaction, { embeds: [embed], components: [row(backButton('wallet'), homeButton())] });
}

const REASONS = {
  initial: '初期残高',
  report: '報告',
  pay: '送金',
  'slot:bet': 'スロット',
  'slot:win': 'スロット当選',
  'coinflip:bet': 'コイントス',
  'coinflip:win': 'コイントス的中',
  'rps:bet': 'じゃんけん',
  'rps:win': 'じゃんけん勝利',
  'rps:refund': 'じゃんけん返金',
  'shop:buy': 'ショップ',
  'admin:give': '管理者から',
  'admin:take': '管理者が回収',
  'admin:set': '管理者が調整',
};

function reasonLabel(row) {
  const base = REASONS[row.reason] ?? row.reason;
  return row.detail && row.reason === 'report' ? `${base}（${row.detail}）` : base;
}

export async function rank(interaction) {
  const settings = getSettings(interaction.guildId);
  const rows = topBalances(interaction.guildId, 15);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 ${settings.currency_name}ランキング`)
    .setDescription(
      rows.length === 0
        ? 'まだ誰も口座を持っていません。'
        : rows
            .map((r, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${r.user_id}> — ${settings.currency_emoji} ${r.balance.toLocaleString('ja-JP')}`)
            .join('\n'),
    );
  return show(interaction, { embeds: [embed], components: [row(backButton('wallet'), homeButton())] });
}

export const actions = { open, pay, payto, paydo, history, rank };
