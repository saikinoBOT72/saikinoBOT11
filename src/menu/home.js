import { getBalance, rankOf } from '../lib/economy.js';
import { listActivities } from '../lib/activities.js';
import { countItems } from '../lib/shop.js';
import { coins } from '../lib/format.js';
import { ButtonStyle } from '../discord/constants.js';
import { button, embed, homeButton, id, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const [rank, activities, items] = await Promise.all([
    rankOf(ctx.db, ix.guildId, ix.userId),
    listActivities(ctx.db, ix.guildId),
    countItems(ctx.db, ix.guildId),
  ]);

  const main = embed({
    color: 0x5865f2,
    author: { name: ix.displayName, icon_url: ix.avatar },
    title: '🏠 メニュー',
    description: `所持金 ${coins(balance, settings)}　（${rank} 位）`,
    fields: [
      { name: '報告できること', value: `${activities.length} 種類`, inline: true },
      { name: '出品中のアイテム', value: `${items} 個`, inline: true },
    ],
    footer: { text: 'ボタンで操作できます。このメニューはあなたにだけ見えています' },
  });

  return show(ix, {
    embeds: [withNotice(main, notice)],
    components: [
      row(
        button(id('report', 'open'), '報告してかせぐ', { emoji: '💪', style: ButtonStyle.SUCCESS }),
        button(id('games', 'open'), 'あそぶ', { emoji: '🎮', style: ButtonStyle.PRIMARY }),
        button(id('shop', 'open'), 'ショップ', { emoji: '🛍️', style: ButtonStyle.PRIMARY }),
      ),
      row(
        button(id('wallet', 'open'), 'お財布', { emoji: '💰' }),
        button(id('wallet', 'rank'), 'ランキング', { emoji: '🏆' }),
        button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
      ),
      row(
        button(id('home', 'help'), '使い方', { emoji: '❓' }),
        button(id('home', 'open'), '更新', { emoji: '🔄' }),
        ix.isAdmin ? button(id('admin', 'open'), '管理', { emoji: '⚙️', style: ButtonStyle.DANGER }) : null,
      ),
    ],
  });
}

export async function help(ix, _args, ctx) {
  const settings = await ctx.settings(ix.guildId);
  const currency = `${settings.currency_emoji}${settings.currency_name}`;

  return show(ix, {
    embeds: [
      embed({
        color: 0x5865f2,
        title: `${currency} の遊び方`,
        description: 'すべてこのメニューのボタンで操作できます。`/menu` でいつでも開けます。',
        fields: [
          {
            name: '💪 報告してかせぐ',
            value:
              '筋トレなどのアクションを選ぶだけで報酬がもらえます。アクションごとに「何時間おき」「1日何回まで」の制限があり、管理者が自由に決められます。',
          },
          {
            name: '🎮 あそぶ',
            value:
              'スロット（最大 x3000）、コイントス（当たれば2倍）、じゃんけん対戦（勝者が総取り）。じゃんけんは相手が承諾すると勝負開始です。',
          },
          {
            name: '🛍️ ショップ',
            value:
              '自分で値段を決めて出品できます。売れた代金はそのまま出品者に入ります。画像URLを設定すると一覧で見栄えがよくなります。',
          },
          { name: '💰 お財布', value: '所持金の確認、他のメンバーへの送金、増減の履歴が見られます。' },
        ],
      }),
    ],
    components: [row(homeButton())],
  });
}

export const actions = { open, help };
