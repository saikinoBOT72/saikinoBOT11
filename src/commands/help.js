import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
} from 'discord.js';
import { getSettings } from '../lib/economy.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('このBotの使い方を表示する')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const settings = getSettings(interaction.guildId);
  const c = `${settings.currency_emoji}${settings.currency_name}`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${c} の使い方`)
    .setDescription(
      `このサーバーでは ${c} を貯めて遊べます。\n**コマンドを覚えるのが面倒なら \`/menu\` だけでOK。**下のボタンからも開けます。`,
    )
    .addFields(
      {
        name: '💪 コインを稼ぐ',
        value: [
          '`/report do activity:筋トレ` — アクションを報告してコイン獲得',
          '`/report list` — 報告できるアクションと報酬の一覧',
          '`/report stats` — これまでの報告実績',
        ].join('\n'),
      },
      {
        name: '🎮 遊ぶ',
        value: [
          '`/slot play bet:100` — スロット（`/slot table` で配当表）',
          '`/coinflip side:表 bet:100` — コイントス（当たれば2倍）',
          '`/rps opponent:@誰か bet:100` — じゃんけん対戦（勝者が総取り）',
        ].join('\n'),
      },
      {
        name: '🛍️ 売り買いする',
        value: [
          '`/shop sell name:券 price:500 image:<画像>` — 画像つきで出品',
          '`/shop list` — 出品一覧 / `/shop show id:1` — 詳細と画像',
          '`/shop buy id:1` — 購入 / `/shop edit`・`/shop remove` — 自分の出品を編集・取り下げ',
          '`/inventory` — 買ったもの・売れたものを確認',
        ].join('\n'),
      },
      {
        name: '💰 お金まわり',
        value: ['`/balance` — 所持金', '`/pay user:@誰か amount:100` — 送金', '`/leaderboard` — ランキング'].join('\n'),
      },
      {
        name: '⚙️ 管理者向け',
        value: [
          '`/activity preset` — おすすめのアクションを一括登録',
          '`/activity add name:筋トレ reward:50 cooldown_minutes:360` — アクション追加・変更',
          '`/economy give`・`/economy take`・`/economy set` — 残高調整',
          '`/economy config` — 通貨名や賭け金上限の設定',
        ].join('\n'),
      },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m:home:open').setLabel('メニューを開く').setEmoji('🏠').setStyle(ButtonStyle.Success),
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}
