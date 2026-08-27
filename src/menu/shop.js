import { getBalance } from '../lib/economy.js';
import { coins, truncate } from '../lib/format.js';
import {
  ShopError,
  countItems,
  createItem,
  getItem,
  inventoryOf,
  listItems,
  purchase,
  salesOf,
  setActive,
  updateItem,
} from '../lib/shop.js';
import { modal, stringSelect, textInput } from '../discord/builders.js';
import { ButtonStyle, TextInputStyle } from '../discord/constants.js';
import {
  backButton,
  button,
  embed,
  homeButton,
  id,
  isError,
  openModal,
  readInt,
  readText,
  row,
  show,
  withNotice,
} from './common.js';

const PAGE_SIZE = 25;

function isImageUrl(url) {
  return /^https?:\/\/\S+$/i.test(url);
}

/* ------------------------------------------------------------------ 一覧 */

export async function open(ix, [rawPage = '0'] = [], ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const page = Math.max(0, Number(rawPage) || 0);
  const [total, items, balance] = await Promise.all([
    countItems(ctx.db, ix.guildId),
    listItems(ctx.db, ix.guildId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    getBalance(ctx.db, ix.guildId, ix.userId),
  ]);

  const description =
    items.length === 0
      ? 'まだ出品がありません。**🆕 出品する** から、値段を決めて出品できます。'
      : `所持金 ${coins(balance, settings)}\n\n` +
        items
          .map((item) => {
            const stock = item.stock < 0 ? '在庫∞' : `残り${item.stock}`;
            return `**#${item.id} ${truncate(item.name, 40)}** — ${settings.currency_emoji}${item.price.toLocaleString('ja-JP')}　*(${stock}・<@${item.seller_id}>)*`;
          })
          .join('\n');

  const components = [];
  if (items.length > 0) {
    components.push(
      stringSelect(
        id('shop', 'view'),
        'アイテムを選んで詳細を見る',
        items.map((item) => ({
          label: truncate(`#${item.id} ${item.name}`, 100),
          value: String(item.id),
          description: truncate(
            `${settings.currency_emoji}${item.price} / ${item.stock < 0 ? '在庫無制限' : `残り${item.stock}`}`,
            100,
          ),
        })),
      ),
    );
  }
  if (total > PAGE_SIZE) {
    components.push(
      row(
        button(id('shop', 'open', String(page - 1)), '前のページ', { emoji: '⬅️', disabled: page === 0 }),
        button(id('shop', 'open', String(page + 1)), '次のページ', {
          emoji: '➡️',
          disabled: (page + 1) * PAGE_SIZE >= total,
        }),
      ),
    );
  }
  components.push(
    row(
      button(id('shop', 'sell'), '出品する', { emoji: '🆕', style: ButtonStyle.SUCCESS }),
      button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }),
      button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
    ),
    row(backButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          title: '🛍️ ショップ',
          description,
          footer: { text: `全 ${total} 件${total > PAGE_SIZE ? `／${page + 1} ページ目` : ''}` },
        }),
        notice,
      ),
    ],
    components,
  });
}

/* ------------------------------------------------------------------ 詳細・購入 */

export async function view(ix, _args, ctx) {
  return detail(ix, Number(ix.values[0]), ctx);
}

export async function view2(ix, [rawId], ctx) {
  return detail(ix, Number(rawId), ctx);
}

async function detail(ix, itemId, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const item = await getItem(ctx.db, ix.guildId, itemId);
  if (!item) return open(ix, [], ctx, 'そのアイテムは見つかりませんでした。');

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const isSeller = item.seller_id === ix.userId;
  const affordable = balance >= item.price;

  let footer;
  if (!item.active) footer = { text: 'この出品は現在停止中です' };
  else if (isSeller) footer = { text: '自分の出品は購入できません' };
  else if (!affordable) footer = { text: '所持金が足りません' };

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: item.active ? 0x1abc9c : 0x95a5a6,
          title: `#${item.id} ${item.name}`,
          description: item.description ?? undefined,
          image: item.image_url ?? undefined,
          fields: [
            { name: '価格', value: coins(item.price, settings), inline: true },
            { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock}`, inline: true },
            { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
            { name: '所持金', value: coins(balance, settings), inline: true },
          ],
          footer,
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('shop', 'confirm', String(item.id)), '購入する', {
          emoji: '💳',
          style: ButtonStyle.SUCCESS,
          disabled: isSeller || !affordable || !item.active,
        }),
        isSeller ? button(id('shop', 'manage', String(item.id)), 'この出品を管理', { emoji: '🔧' }) : null,
      ),
      row(backButton('shop', '一覧へ'), homeButton()),
    ],
  });
}

export async function confirm(ix, [rawId], ctx) {
  const settings = await ctx.settings(ix.guildId);
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return open(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      embed({
        color: 0xf39c12,
        title: '本当に買いますか？',
        description: `**${item.name}** を ${coins(item.price, settings)} で購入します。`,
        thumbnail: item.image_url ?? undefined,
        fields: [
          { name: '購入後の所持金', value: coins(balance - item.price, settings), inline: true },
          { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
        ],
      }),
    ],
    components: [
      row(
        button(id('shop', 'buy', String(item.id)), '購入する', { emoji: '✅', style: ButtonStyle.SUCCESS }),
        button(id('shop', 'view2', String(item.id)), 'やめる', { emoji: '↩️' }),
      ),
    ],
  });
}

export async function buy(ix, [rawId], ctx) {
  const settings = await ctx.settings(ix.guildId);
  let item;
  try {
    item = await purchase(ctx.db, ix.guildId, Number(rawId), ix.userId);
  } catch (error) {
    if (error instanceof ShopError) return open(ix, [], ctx, error.message);
    throw error;
  }

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  ctx.announce(ix.channelId, {
    embeds: [
      embed({
        color: 0x1abc9c,
        title: '🧾 購入がありました',
        description: `<@${ix.userId}> が <@${item.seller_id}> の **${item.name}** を ${coins(item.price, settings)} で購入しました。`,
        thumbnail: item.image_url ?? undefined,
      }),
    ],
    allowed_mentions: { users: [item.seller_id] },
  });

  return show(ix, {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '✅ 購入しました',
        description: `**${item.name}** を手に入れました。\n所持金は ${coins(balance, settings)} です。`,
        footer: { text: '出品者に代金が渡りました。受け渡しは当人同士でどうぞ' },
      }),
    ],
    components: [
      row(
        button(id('shop', 'open'), 'ショップに戻る', { emoji: '🛍️' }),
        button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
        homeButton(),
      ),
    ],
  });
}

/* ------------------------------------------------------------------ 出品 */

export function sell() {
  return openModal(
    modal(id('shop', 'create'), 'アイテムを出品する', [
      textInput('name', 'アイテム名', { placeholder: '例: 肩たたき券', required: true, max: 60 }),
      textInput('price', '価格', { placeholder: '例: 500', required: true, max: 12 }),
      textInput('description', '説明（任意）', { style: TextInputStyle.PARAGRAPH, max: 400 }),
      textInput('stock', '在庫数（空欄なら無制限）', { placeholder: '例: 3', max: 6 }),
      textInput('image_url', '画像のURL（任意）', { placeholder: 'https://...', max: 300 }),
    ]),
  );
}

export async function create(ix, _args, ctx) {
  const name = readText(ix, 'name');
  const price = readInt(ix, 'price', { min: 0 });
  const stock = readInt(ix, 'stock', { min: 1, fallback: -1 });
  const imageUrl = readText(ix, 'image_url');

  if (!name) return open(ix, [], ctx, 'アイテム名を入力してください。');
  if (isError(price)) return open(ix, [], ctx, price.error);
  if (isError(stock)) return open(ix, [], ctx, stock.error);
  if (imageUrl && !isImageUrl(imageUrl)) return open(ix, [], ctx, '画像URLは http(s) から始まるURLを入力してください。');

  const item = await createItem(ctx.db, {
    guildId: ix.guildId,
    sellerId: ix.userId,
    name,
    description: readText(ix, 'description'),
    price,
    imageUrl,
    stock,
  });

  return manage(ix, [String(item.id)], ctx, '出品しました！');
}

/* ------------------------------------------------------------------ 自分の出品 */

export async function mine(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const items = await listItems(ctx.db, ix.guildId, { sellerId: ix.userId, includeInactive: true, limit: 25 });
  const sales = await salesOf(ctx.db, ix.guildId, ix.userId);
  const revenue = sales.reduce((sum, entry) => sum + entry.total, 0);

  const components = [];
  if (items.length > 0) {
    components.push(
      stringSelect(
        id('shop', 'manage2'),
        '編集する出品を選ぶ',
        items.map((item) => ({
          label: truncate(`#${item.id} ${item.name}`, 100),
          value: String(item.id),
          description: truncate(`${settings.currency_emoji}${item.price} / ${item.active ? '販売中' : '停止中'}`, 100),
        })),
      ),
    );
  }
  components.push(
    row(
      button(id('shop', 'sell'), '出品する', { emoji: '🆕', style: ButtonStyle.SUCCESS }),
      backButton('shop', 'ショップへ'),
      homeButton(),
    ),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          title: '📦 自分の出品',
          description:
            items.length === 0
              ? 'まだ出品していません。**🆕 出品する** から始められます。'
              : items
                  .map((item) => {
                    const state = item.active ? (item.stock < 0 ? '在庫∞' : `残り${item.stock}`) : '停止中';
                    return `**#${item.id} ${truncate(item.name, 40)}** — ${settings.currency_emoji}${item.price}　*(${state}・${item.sold}個売れた)*`;
                  })
                  .join('\n'),
          fields: revenue > 0 ? [{ name: '売上合計', value: coins(revenue, settings), inline: true }] : [],
        }),
        notice,
      ),
    ],
    components,
  });
}

export async function manage2(ix, _args, ctx) {
  return manage(ix, [ix.values[0]], ctx);
}

export async function manage(ix, [rawId], ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ編集できます。');

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          title: `🔧 #${item.id} ${item.name}`,
          description: item.description ?? undefined,
          image: item.image_url ?? undefined,
          fields: [
            { name: '価格', value: coins(item.price, settings), inline: true },
            { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock}`, inline: true },
            { name: '売れた数', value: `${item.sold}`, inline: true },
            { name: '状態', value: item.active ? '販売中' : '停止中', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('shop', 'edit', String(item.id)), '内容を編集', { emoji: '✏️', style: ButtonStyle.PRIMARY }),
        button(id('shop', 'remove', String(item.id)), item.active ? '取り下げる' : '再開する', {
          emoji: item.active ? '🗑️' : '♻️',
          style: item.active ? ButtonStyle.DANGER : ButtonStyle.SUCCESS,
        }),
      ),
      row(backButton('shop', 'ショップへ'), button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }), homeButton()),
    ],
  });
}

export async function edit(ix, [rawId], ctx) {
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ編集できます。');

  return openModal(
    modal(id('shop', 'update', String(item.id)), `#${item.id} を編集`, [
      textInput('name', 'アイテム名', { required: true, max: 60, value: item.name }),
      textInput('price', '価格', { required: true, max: 12, value: String(item.price) }),
      textInput('description', '説明（任意）', {
        style: TextInputStyle.PARAGRAPH,
        max: 400,
        value: item.description ?? '',
      }),
      textInput('stock', '在庫数（空欄なら無制限）', { max: 6, value: item.stock < 0 ? '' : String(item.stock) }),
      textInput('image_url', '画像のURL（任意）', { max: 300, value: item.image_url ?? '' }),
    ]),
  );
}

export async function update(ix, [rawId], ctx) {
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ編集できます。');

  const name = readText(ix, 'name');
  const price = readInt(ix, 'price', { min: 0 });
  const stock = readInt(ix, 'stock', { min: 0, fallback: -1 });
  const imageUrl = readText(ix, 'image_url');

  if (!name) return manage(ix, [rawId], ctx, 'アイテム名を入力してください。');
  if (isError(price)) return manage(ix, [rawId], ctx, price.error);
  if (isError(stock)) return manage(ix, [rawId], ctx, stock.error);
  if (imageUrl && !isImageUrl(imageUrl)) return manage(ix, [rawId], ctx, '画像URLは http(s) から始まるURLにしてください。');

  await updateItem(ctx.db, ix.guildId, item.id, {
    name,
    price,
    description: readText(ix, 'description'),
    stock,
    image_url: imageUrl,
    active: stock === 0 ? 0 : 1,
  });

  return manage(ix, [rawId], ctx, '内容を更新しました');
}

export async function remove(ix, [rawId], ctx) {
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ操作できます。');

  if (item.active) {
    await setActive(ctx.db, ix.guildId, item.id, false);
    return manage(ix, [rawId], ctx, '出品を取り下げました');
  }
  await updateItem(ctx.db, ix.guildId, item.id, { active: 1, stock: item.stock === 0 ? -1 : item.stock });
  return manage(ix, [rawId], ctx, '販売を再開しました');
}

/* ------------------------------------------------------------------ 持ち物 */

export async function inventory(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const owned = await inventoryOf(ctx.db, ix.guildId, ix.userId);
  const sales = await salesOf(ctx.db, ix.guildId, ix.userId);

  const fields = [];
  if (owned.length > 0) {
    fields.push({
      name: '購入合計',
      value: coins(owned.reduce((sum, entry) => sum + entry.total, 0), settings),
      inline: true,
    });
  }
  if (sales.length > 0) {
    fields.push({
      name: '売上合計',
      value: coins(sales.reduce((sum, entry) => sum + entry.total, 0), settings),
      inline: true,
    });
  }

  const components = [];
  if (owned.length > 0) {
    components.push(
      stringSelect(
        id('shop', 'view'),
        '持っているアイテムを見る',
        owned.map((entry) => ({
          label: truncate(`#${entry.item_id} ${entry.name}`, 100),
          value: String(entry.item_id),
          description: `×${entry.count}`,
        })),
      ),
    );
  }
  components.push(row(button(id('shop', 'open'), 'ショップへ', { emoji: '🛍️' }), homeButton()));

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: '🎒 持ち物',
          description:
            owned.length === 0
              ? 'まだ何も持っていません。ショップを覗いてみましょう。'
              : owned
                  .map(
                    (entry) =>
                      `• **${truncate(entry.name, 40)}** ×${entry.count}　*(#${entry.item_id}・計 ${settings.currency_emoji}${entry.total})*`,
                  )
                  .join('\n'),
          fields,
        }),
        notice,
      ),
    ],
    components,
  });
}

export const actions = {
  open,
  view,
  view2,
  confirm,
  buy,
  sell,
  create,
  mine,
  manage,
  manage2,
  edit,
  update,
  remove,
  inventory,
};
