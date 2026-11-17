/**
 * 管理メニュー：出品の取り下げ。
 *
 * 決まりに合わない出品（現実のお金とのやり取り、人を傷つける内容など）を
 * 管理者が売り場から外す。取り下げた出品は出品者が自分で再開できない。
 * 取り下げを解いても販売は止まったままで、再開するかは出品者に任せる。
 */
import { getItem, moderationList, takeDown } from '../lib/shop.js';
import { coins, truncate } from '../lib/format.js';
import { stringSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { COLORS, backButton, button, embed, id, row, show, withNotice } from './common.js';
import { open as openHome } from './home.js';

function denied(ix, ctx) {
  return openHome(ix, [], ctx, 'この操作には「サーバー管理」権限が必要です。');
}

export async function items(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const list = await moderationList(ctx.db, ix.guildId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLORS.admin,
          title: '🚫 出品の取り下げ',
          description:
            list.length === 0
              ? '販売中の出品はありません。'
              : '決まりに合わない出品を売り場から外せます。取り下げた出品は、出品者が自分では再開できません。\n\n' +
                list
                  .map(
                    (item) =>
                      `${item.taken_down ? '🚫' : '🟢'} **#${item.id} ${truncate(item.name, 40)}** — ${coins(item.price, settings)}　*(<@${item.seller_id}>)*`,
                  )
                  .join('\n'),
        }),
        notice,
      ),
    ],
    components: [
      list.length > 0
        ? stringSelect(
            id('admin', 'itempick'),
            '出品を選ぶ',
            list.map((item) => ({
              label: truncate(`#${item.id} ${item.name}`, 100),
              value: String(item.id),
              emoji: item.taken_down ? '🚫' : '🟢',
              description: item.taken_down ? '取り下げ済み' : '販売中',
            })),
          )
        : null,
      row(backButton('admin', '管理メニューへ')),
    ],
  });
}

export async function itempick(ix, _args, ctx) {
  return itemview(ix, [ix.values[0]], ctx);
}

export async function itemview(ix, [rawId], ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return items(ix, [], ctx, 'その出品は見つかりませんでした。');

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: item.taken_down ? COLORS.stop : COLORS.admin,
          title: `#${item.id} ${truncate(item.name, 80)}`,
          description: item.description ?? undefined,
          image: item.image_url ?? undefined,
          fields: [
            { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
            { name: '価格', value: coins(item.price, settings), inline: true },
            { name: '状態', value: item.taken_down ? '🚫 取り下げ済み' : item.active ? '🟢 販売中' : '停止中', inline: true },
          ],
          footer: { text: 'すでに買われたぶんは、買った人の持ち物に残ります' },
        }),
        notice,
      ),
    ],
    components: [
      row(
        item.taken_down
          ? button(id('admin', 'itemup', String(item.id)), '取り下げを解く', { emoji: '♻️' })
          : button(id('admin', 'itemdown', String(item.id)), '取り下げる', { emoji: '🚫', style: ButtonStyle.DANGER }),
        button(id('admin', 'items'), '一覧へ', { emoji: '↩️' }),
      ),
    ],
  });
}

export async function itemdown(ix, [rawId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const item = await takeDown(ctx.db, ix.guildId, Number(rawId), true);
  if (!item) return items(ix, [], ctx, 'その出品は見つかりませんでした。');
  return itemview(ix, [rawId], ctx, '取り下げました。出品者の「自分の出品」にも取り下げたことが表示されます');
}

export async function itemup(ix, [rawId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const item = await takeDown(ctx.db, ix.guildId, Number(rawId), false);
  if (!item) return items(ix, [], ctx, 'その出品は見つかりませんでした。');
  return itemview(ix, [rawId], ctx, '取り下げを解きました。販売を再開するかは出品者が決めます');
}

export const itemActions = { items, itempick, itemview, itemdown, itemup };
