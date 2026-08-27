import { countUserData, deleteUserData } from '../lib/privacy.js';
import { coins } from '../lib/format.js';
import { ButtonStyle } from '../discord/constants.js';
import { backButton, button, embed, homeButton, id, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const data = await countUserData(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x95a5a6,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: '🔐 自分のデータ',
          description:
            'このBotがあなたについて保存しているのは、以下のものだけです。\n' +
            'DiscordのユーザーIDと、このサーバーでの遊んだ記録です。メッセージの中身は読んでいません。',
          fields: [
            { name: '所持金', value: coins(data.balance, settings), inline: true },
            { name: 'コインの増減記録', value: `${data.ledger} 件`, inline: true },
            { name: '報告の記録', value: `${data.reports} 件`, inline: true },
            { name: '出品', value: `${data.items} 件`, inline: true },
            { name: '購入履歴', value: `${data.purchases} 件`, inline: true },
          ],
          footer: { text: 'いつでも自分で全部消せます' },
        }),
        notice,
      ),
    ],
    components: [
      row(button(id('privacy', 'confirm'), 'データを削除する', { emoji: '🗑️', style: ButtonStyle.DANGER })),
      row(backButton('wallet'), homeButton()),
    ],
  });
}

export async function confirm(ix, _args, ctx) {
  const data = await countUserData(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      embed({
        color: 0xe74c3c,
        title: '本当に削除しますか？',
        description:
          '**所持金・報告の記録・出品・購入履歴がすべて消えます。元には戻せません。**\n\n' +
          `いま消えるもの: 所持金 ${data.balance}／記録 ${data.ledger + data.reports} 件／出品 ${data.items} 件\n\n` +
          '削除後にまた遊ぶと、新しく初期残高から始まります。',
      }),
    ],
    components: [
      row(
        button(id('privacy', 'purge'), '完全に削除する', { emoji: '🗑️', style: ButtonStyle.DANGER }),
        button(id('privacy', 'open'), 'やめる', { emoji: '↩️', style: ButtonStyle.SECONDARY }),
      ),
    ],
  });
}

export async function purge(ix, _args, ctx) {
  const removed = await deleteUserData(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      embed({
        color: 0x95a5a6,
        title: '🗑️ 削除しました',
        description:
          `あなたのデータを削除しました（記録 ${removed.ledger + removed.reports} 件／出品 ${removed.items} 件）。\n` +
          'ほかの人の購入履歴は相手の記録なので残りますが、そこからあなたのIDは消してあります。',
      }),
    ],
    components: [row(homeButton())],
  });
}

export const actions = { open, confirm, purge };
