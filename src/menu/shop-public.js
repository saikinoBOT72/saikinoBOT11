/**
 * チャンネルに流れたショップのお知らせについているボタン（sp:…）。
 *
 * 【メニューと分けている理由】
 * メニューのボタン（m:…）は押されたメッセージを書き換える。お知らせは
 * みんなが見ているので、誰かが押した瞬間に別の画面へ化けては困る。
 * ここでは、押した人にだけ見える新しい画面を開くか、出品者が押したときだけ
 * お知らせに「対応済み」の印を足す。
 */
import { markDelivered } from '../lib/shop.js';
import { reply, update } from '../discord/respond.js';
import { asNewMessage, plainEmbed } from './common.js';
import { PUBLIC_PREFIX, view2 } from './shop.js';

export const namespace = PUBLIC_PREFIX;

/** 🛒 見る・買う：押した人にだけ商品ページを開く（そこから買える）。 */
async function buy(ix, [rawId], ctx) {
  return view2(asNewMessage(ix), [rawId], ctx);
}

/** ✅ 対応した：出品者だけが押せる。お知らせに印を付けてボタンを外す。 */
async function done(ix, [rawId], ctx) {
  const purchase = await ctx.db.get('SELECT * FROM purchases WHERE guild_id = ?1 AND id = ?2', ix.guildId, Number(rawId));
  if (!purchase) return reply({ content: 'この記録は見つかりませんでした（消されたのかもしれません）。' });
  if (purchase.seller_id !== ix.userId) return reply({ content: '「対応した」は出品者だけが押せます。' });

  await markDelivered(ctx.db, ix.guildId, purchase.id, ix.userId);
  const latest = await ctx.db.get('SELECT delivered_at FROM purchases WHERE id = ?1', purchase.id);
  const when = Math.floor((latest?.delivered_at ?? Date.now()) / 1000);

  const [first, ...rest] = (ix.raw.message?.embeds ?? []).map(plainEmbed);
  const stamp = { name: '受け渡し', value: `✅ 対応済み（<t:${when}:R>）`, inline: true };
  const embeds = first ? [{ ...first, fields: [...(first.fields ?? []), stamp] }, ...rest] : [];
  return update({ embeds, components: [] });
}

const ACTIONS = { buy, done };

export async function handleComponent(ix, ctx) {
  const [, action, ...args] = ix.customId.split(':');
  const handler = ACTIONS[action];
  if (!handler) return reply({ content: 'この操作は使えなくなっています。' });
  return handler(ix, args, ctx);
}
