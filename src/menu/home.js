import { EmbedBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { getBalance, getSettings, rankOf } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { listActivities } from '../lib/activities.js';
import { countItems } from '../lib/shop.js';
import { button, homeButton, id, row, show } from './common.js';

export function render(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const balance = getBalance(guildId, interaction.user.id);
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('🏠 メニュー')
    .setDescription(`所持金 ${coins(balance, settings)}　（${rankOf(guildId, interaction.user.id)} 位）`)
    .addFields(
      { name: '報告できること', value: `${listActivities(guildId).length} 種類`, inline: true },
      { name: '出品中のアイテム', value: `${countItems(guildId)} 個`, inline: true },
    )
    .setFooter({ text: 'ボタンで操作できます。このメニューはあなたにだけ見えています' });

  const components = [
    row(
      button(id('report', 'open'), '報告してかせぐ', { emoji: '💪', style: ButtonStyle.Success }),
      button(id('games', 'open'), 'あそぶ', { emoji: '🎮', style: ButtonStyle.Primary }),
      button(id('shop', 'open'), 'ショップ', { emoji: '🛍️', style: ButtonStyle.Primary }),
    ),
    row(
      button(id('wallet', 'open'), 'お財布', { emoji: '💰' }),
      button(id('wallet', 'rank'), 'ランキング', { emoji: '🏆' }),
      button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
    ),
    row(
      button(id('home', 'help'), '使い方', { emoji: '❓' }),
      button(id('home', 'open'), '更新', { emoji: '🔄' }),
      isAdmin ? button(id('admin', 'open'), '管理', { emoji: '⚙️', style: ButtonStyle.Danger }) : null,
    ),
  ];

  return { embeds: [embed], components };
}

export async function open(interaction) {
  return show(interaction, render(interaction));
}

export async function help(interaction) {
  const settings = getSettings(interaction.guildId);
  const currency = `${settings.currency_emoji}${settings.currency_name}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${currency} の遊び方`)
    .setDescription(`メニューのボタンだけで一通り操作できます。スラッシュコマンドを直接使うこともできます。`)
    .addFields(
      {
        name: '💪 報告してかせぐ',
        value: '筋トレなどのアクションを選ぶだけで報酬がもらえます。アクションごとに「何時間おき」「1日何回まで」の制限があります。写真が必要なものは、案内に従って画像を送ってください。',
      },
      {
        name: '🎮 あそぶ',
        value: 'スロット（最大 x3000）、コイントス（当たれば2倍）、じゃんけん対戦（勝者が総取り）。じゃんけんは相手が承諾すると勝負開始です。',
      },
      {
        name: '🛍️ ショップ',
        value: '自分で値段と画像を決めて出品できます。売れた分の代金はそのまま出品者に入ります。在庫を決めれば売り切れで自動的に販売停止になります。',
      },
      {
        name: '💰 お財布',
        value: '所持金の確認、他のメンバーへの送金、増減の履歴が見られます。',
      },
      {
        name: '⌨️ コマンドでも使えます',
        value: '`/menu` `/report do` `/slot play` `/coinflip` `/rps` `/shop sell` `/shop buy` `/pay` `/balance` `/leaderboard` `/inventory`',
      },
    );

  return show(interaction, { embeds: [embed], components: [row(homeButton())] });
}

export const actions = { open, help };
