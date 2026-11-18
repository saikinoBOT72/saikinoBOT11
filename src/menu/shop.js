import { getBalance } from '../lib/economy.js';
import { equippedTitle, titleTag } from '../lib/achievements.js';
import { coins, truncate } from '../lib/format.js';
import {
  ITEM_KINDS,
  SORTS,
  ShopError,
  browseItems,
  countItems,
  createItem,
  getItem,
  inventoryOf,
  isConsumable,
  listItems,
  markDelivered,
  ownedItem,
  pendingDeliveries,
  purchase,
  salesOf,
  setActive,
  updateItem,
  useItem,
} from '../lib/shop.js';
import { modal, stringSelect, textInput } from '../discord/builders.js';
import { realMoneyWord } from '../lib/text.js';
import { ButtonStyle, TextInputStyle } from '../discord/constants.js';
import {
  COLORS,
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

/**
 * コインを現金や電子マネーと交換する出品は受け付けない。
 * コインに現実のお金の価値を持たせると、遊びのポイントではなく賭博の道具になってしまうため。
 */
function realMoneyMessage(word) {
  return (
    `${word}とのやり取りに見える出品は受け付けていません。` +
    'コインは現金・電子マネー・ギフト券などと交換できない決まりです（「肩たたき券」「1回おごり」のような身内のやり取りは大丈夫です）。'
  );
}

function isImageUrl(url) {
  return /^https?:\/\/\S+$/i.test(url);
}

function kindLabel(value) {
  const meta = ITEM_KINDS[value] ?? ITEM_KINDS.consumable;
  return `${meta.emoji} ${meta.label}`;
}

function otherKind(value) {
  return isConsumable(value) ? ITEM_KINDS.permanent : ITEM_KINDS.consumable;
}

function stateLabel(item) {
  if (item.taken_down) return '🚫 管理者が取り下げ';
  if (!item.active) return '停止中';
  return item.stock < 0 ? '在庫∞' : `残り${item.stock}`;
}

function usableCount(entry) {
  return isConsumable(entry.kind) ? entry.usable : entry.count;
}

/* ------------------------------------------------------------------ 一覧 */

/** 公開メッセージに付ける、押した人にだけ商品ページを開くボタン。 */
export const PUBLIC_PREFIX = 'sp';

export async function open(ix, [rawPage = '0', rawSort = 'new'] = [], ctx, notice = null) {
  const sort = SORTS[rawSort] ? rawSort : 'new';
  const page = Math.max(0, Number(rawPage) || 0);
  const [total, items] = await Promise.all([
    countItems(ctx.db, ix.guildId),
    browseItems(ctx.db, ix.guildId, { sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  ]);
  return listing(ix, ctx, { items, total, page, sort, notice });
}

/** 🔍 探す：名前か説明に含まれる言葉で絞り込む。 */
export function search() {
  return openModal(
    modal(id('shop', 'find'), 'ショップで探す', [
      textInput('q', '探す言葉（名前・説明から探します）', { placeholder: '例: 券', required: true, max: 40 }),
    ]),
  );
}

export async function find(ix, _args, ctx) {
  const query = readText(ix, 'q', { line: true, max: 40 });
  if (!query) return open(ix, [], ctx, '探す言葉を入れてください。');
  const items = await browseItems(ctx.db, ix.guildId, { query, limit: PAGE_SIZE });
  return listing(ix, ctx, { items, total: items.length, page: 0, sort: 'new', query });
}

/** 一覧の画面（ふつうの一覧と、探した結果で共通）。 */
async function listing(ix, ctx, { items, total, page, sort, query = null, notice = null }) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  let description;
  if (items.length === 0) {
    description = query
      ? `「${truncate(query, 40)}」に当てはまる出品はありませんでした。`
      : 'まだ出品がありません。**🆕 出品する** から、値段を決めて出品できます。';
  } else {
    description =
      `所持金 ${coins(balance, settings)}\n\n` +
      items
        .map((item) => {
          const stock = item.stock < 0 ? '在庫∞' : `残り${item.stock}`;
          const sold = sort === 'popular' && item.sold > 0 ? `・${item.sold}個売れた` : '';
          return `**#${item.id} ${truncate(item.name, 40)}** — ${settings.currency_emoji}${item.price.toLocaleString('ja-JP')}　*(${stock}${sold}・<@${item.seller_id}>)*`;
        })
        .join('\n');
  }

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

  if (query) {
    components.push(
      row(
        button(id('shop', 'search'), 'ほかの言葉で探す', { emoji: '🔍', style: ButtonStyle.PRIMARY }),
        button(id('shop', 'open'), '探すのをやめる', { emoji: '↩️' }),
      ),
    );
  } else {
    // 並べ方（いま選んでいるものは押せない＝目印）と、探すボタン
    components.push(
      row(
        ...Object.entries(SORTS).map(([key, meta]) =>
          button(id('shop', 'open', '0', key), meta.label, {
            emoji: meta.emoji,
            style: key === sort ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
            disabled: key === sort,
          }),
        ),
        button(id('shop', 'search'), '探す', { emoji: '🔍' }),
      ),
    );
    if (total > PAGE_SIZE) {
      components.push(
        row(
          button(id('shop', 'open', String(page - 1), sort), '前のページ', { emoji: '⬅️', disabled: page === 0 }),
          button(id('shop', 'open', String(page + 1), sort), '次のページ', {
            emoji: '➡️',
            disabled: (page + 1) * PAGE_SIZE >= total,
          }),
        ),
      );
    }
  }
  components.push(
    row(
      button(id('shop', 'sell'), '出品する', { emoji: '🆕', style: ButtonStyle.SUCCESS }),
      button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }),
      button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
      backButton(),
    ),
  );

  const footer = query
    ? `「${truncate(query, 30)}」で ${items.length} 件${items.length >= PAGE_SIZE ? '（多いので先頭の25件）' : ''}`
    : `${SORTS[sort].label}・全 ${total} 件${total > PAGE_SIZE ? `／${page + 1} ページ目` : ''}`;

  return show(ix, {
    embeds: [
      withNotice(
        embed({ color: COLORS.shop, title: query ? '🔍 ショップで探す' : '🛍️ ショップ', description, footer: { text: footer } }),
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
            { name: '種類', value: kindLabel(item.kind), inline: true },
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
  // 出品者にだけ通知を鳴らす（名前を本文に書かないと、allowed_mentions に入れても鳴らない）
  ctx.announce(ix.channelId, {
    content:
      `🧾 <@${ix.userId}> が **${truncate(item.name, 60)}** を ${coins(item.price, settings)} で購入しました。` +
      `\n出品者: <@${item.seller_id}>`,
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

export async function sell(ix, _args, _ctx) {
  return show(ix, {
    embeds: [
      embed({
        color: 0x1abc9c,
        title: '🆕 出品する',
        description: 'まず、どんなアイテムかを選んでください。',
        fields: Object.entries(ITEM_KINDS).map(([, kind]) => ({
          name: `${kind.emoji} ${kind.label}`,
          value: kind.hint,
          inline: true,
        })),
      }),
    ],
    components: [
      row(
        button(id('shop', 'sellform', 'consumable'), ITEM_KINDS.consumable.label, {
          emoji: ITEM_KINDS.consumable.emoji,
          style: ButtonStyle.SUCCESS,
        }),
        button(id('shop', 'sellform', 'permanent'), ITEM_KINDS.permanent.label, {
          emoji: ITEM_KINDS.permanent.emoji,
          style: ButtonStyle.PRIMARY,
        }),
      ),
      row(backButton('shop', 'やめる')),
    ],
  });
}

export function sellform(ix, [kind]) {
  const meta = ITEM_KINDS[kind] ?? ITEM_KINDS.consumable;
  return openModal(
    modal(id('shop', 'create', kind), `出品する（${meta.label}）`, [
      textInput('name', 'アイテム名', { placeholder: '例: 肩たたき券', required: true, max: 60 }),
      textInput('price', '価格', { placeholder: '例: 500', required: true, max: 12 }),
      textInput('description', '説明（任意）', { style: TextInputStyle.PARAGRAPH, max: 400 }),
      textInput('stock', '在庫数（空欄なら無制限）', { placeholder: '例: 3', max: 6 }),
      textInput('image_url', '画像のURL（任意）', { placeholder: 'https://...', max: 300 }),
    ]),
  );
}

export async function create(ix, [kind = 'consumable'] = [], ctx) {
  const name = readText(ix, 'name', { line: true, max: 60 });
  const price = readInt(ix, 'price', { min: 0 });
  const stock = readInt(ix, 'stock', { min: 1, fallback: -1 });
  const imageUrl = readText(ix, 'image_url');

  if (!name) return open(ix, [], ctx, 'アイテム名を入力してください。');
  const money = realMoneyWord(`${name} ${readText(ix, 'description') ?? ''}`);
  if (money) return open(ix, [], ctx, realMoneyMessage(money));
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
    kind: ITEM_KINDS[kind] ? kind : 'consumable',
  });

  await announceListing(ix, ctx, item);
  return manage(ix, [String(item.id)], ctx, '出品しました！ チャンネルにも知らせました');
}

/** 新しい出品をみんなに知らせる。 */
async function announceListing(ix, ctx, item) {
  const settings = await ctx.settings(ix.guildId);
  const title = await equippedTitle(ctx.db, ix.guildId, ix.userId);
  const tag = titleTag(title);

  const meta = ITEM_KINDS[item.kind] ?? ITEM_KINDS.consumable;
  /** @type {Array<{name: string, value: string, inline?: boolean}>} */
  const fields = [
    { name: '価格', value: coins(item.price, settings), inline: true },
    { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock} 個`, inline: true },
    { name: '商品番号', value: `#${item.id}`, inline: true },
    { name: '種類', value: `${meta.emoji} ${meta.label}`, inline: true },
  ];
  if (item.description) fields.push({ name: '説明', value: truncate(item.description, 400) });

  ctx.announce(ix.channelId, {
    embeds: [
      embed({
        color: 0x1abc9c,
        author: { name: `${tag ? `【${tag}】` : ''}${ix.displayName}`, icon_url: ix.avatar },
        title: `🆕 ${truncate(item.name, 80)} が出品されました！`,
        description: `<@${ix.userId}> が出品しました。`,
        image: item.image_url ?? undefined,
        fields,
        footer: { text: '「見る・買う」を押すと、押した人にだけ商品ページが開きます' },
      }),
    ],
    components: [
      row(
        button(`${PUBLIC_PREFIX}:buy:${item.id}`, '見る・買う', { emoji: '🛒', style: ButtonStyle.SUCCESS }),
      ),
    ],
    allowed_mentions: { parse: [] },
  });
}

/* ------------------------------------------------------------------ 自分の出品 */

export async function mine(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const items = await listItems(ctx.db, ix.guildId, { sellerId: ix.userId, includeInactive: true, limit: 25 });
  const sales = await salesOf(ctx.db, ix.guildId, ix.userId);
  const revenue = sales.reduce((sum, entry) => sum + entry.total, 0);
  const pending = await pendingDeliveries(ctx.db, ix.guildId, ix.userId);

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
      button(id('shop', 'pending'), `対応待ち ${pending.length} 件`, {
        emoji: '📬',
        style: pending.length > 0 ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
        disabled: pending.length === 0,
      }),
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
                    const state = stateLabel(item);
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

/** 使われたのに、まだ「対応した」を押していないもの。ここからも押せる。 */
export async function pending(ix, _args, ctx, notice = null) {
  const list = await pendingDeliveries(ctx.db, ix.guildId, ix.userId);
  const seconds = (ms) => Math.floor(ms / 1000);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLORS.shop,
          title: '📬 対応待ち',
          description:
            list.length === 0
              ? '対応待ちはありません。おつかれさまでした！'
              : list
                  .map((entry) => `• **${truncate(entry.name, 40)}** — <@${entry.buyer_id}> が <t:${seconds(entry.used_at)}:R> に使用`)
                  .join('\n'),
          footer: list.length > 0 ? { text: '受け渡しが済んだものを選ぶと「対応した」になります' } : undefined,
        }),
        notice,
      ),
    ],
    components: [
      list.length > 0
        ? stringSelect(
            id('shop', 'deliver'),
            '対応したものを選ぶ',
            list.map((entry) => ({
              label: truncate(entry.name, 100),
              value: String(entry.id),
              description: truncate(`購入番号 ${entry.id}`, 100),
            })),
          )
        : null,
      row(button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }), homeButton()),
    ],
  });
}

export async function deliver(ix, _args, ctx) {
  const marked = await markDelivered(ctx.db, ix.guildId, Number(ix.values[0]), ix.userId);
  return pending(ix, [], ctx, marked ? '「対応した」にしました' : 'もう対応済みか、見つかりませんでした。');
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
            { name: '種類', value: kindLabel(item.kind), inline: true },
            { name: '状態', value: stateLabel(item), inline: true },
          ],
          footer: item.taken_down
            ? { text: '管理者が取り下げました。再開したいときはサーバーの管理者に相談してください' }
            : undefined,
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('shop', 'edit', String(item.id)), '内容を編集', { emoji: '✏️', style: ButtonStyle.PRIMARY }),
        button(id('shop', 'kind', String(item.id)), `種類を「${otherKind(item.kind).label}」に`, {
          emoji: otherKind(item.kind).emoji,
        }),
        button(id('shop', 'remove', String(item.id)), item.active ? '取り下げる' : '再開する', {
          emoji: item.active ? '🗑️' : '♻️',
          style: item.active ? ButtonStyle.DANGER : ButtonStyle.SUCCESS,
          disabled: Boolean(item.taken_down),
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

  const name = readText(ix, 'name', { line: true, max: 60 });
  const price = readInt(ix, 'price', { min: 0 });
  const stock = readInt(ix, 'stock', { min: 0, fallback: -1 });
  const imageUrl = readText(ix, 'image_url');

  if (!name) return manage(ix, [rawId], ctx, 'アイテム名を入力してください。');
  const money = realMoneyWord(`${name} ${readText(ix, 'description') ?? ''}`);
  if (money) return manage(ix, [rawId], ctx, realMoneyMessage(money));
  if (isError(price)) return manage(ix, [rawId], ctx, price.error);
  if (isError(stock)) return manage(ix, [rawId], ctx, stock.error);
  if (imageUrl && !isImageUrl(imageUrl)) return manage(ix, [rawId], ctx, '画像URLは http(s) から始まるURLにしてください。');

  await updateItem(ctx.db, ix.guildId, item.id, {
    name,
    price,
    description: readText(ix, 'description'),
    stock,
    image_url: imageUrl,
    // 管理者が取り下げたものは、編集しても売り場に戻さない
    active: stock === 0 || item.taken_down ? 0 : 1,
  });

  return manage(ix, [rawId], ctx, '内容を更新しました');
}

export async function kind(ix, [rawId], ctx) {
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ編集できます。');

  const next = isConsumable(item.kind) ? 'permanent' : 'consumable';
  await updateItem(ctx.db, ix.guildId, item.id, { kind: next });
  return manage(ix, [rawId], ctx, `種類を「${ITEM_KINDS[next].label}」にしました（これから買われるぶんに適用されます）`);
}

export async function remove(ix, [rawId], ctx) {
  const item = await getItem(ctx.db, ix.guildId, Number(rawId));
  if (!item) return mine(ix, [], ctx, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== ix.userId) return open(ix, [], ctx, '自分の出品だけ操作できます。');

  if (item.active) {
    await setActive(ctx.db, ix.guildId, item.id, false);
    return manage(ix, [rawId], ctx, '出品を取り下げました');
  }
  if (item.taken_down) return manage(ix, [rawId], ctx, '管理者が取り下げた出品は、自分では再開できません。');
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
        id('shop', 'owned'),
        '持っているアイテムを見る・使う',
        owned.map((entry) => ({
          label: truncate(`${entry.name} ×${usableCount(entry)}`, 100),
          value: String(entry.item_id),
          emoji: (ITEM_KINDS[entry.kind] ?? ITEM_KINDS.consumable).emoji,
          description: truncate(
            isConsumable(entry.kind) ? `使い切り・使える数 ${entry.usable}` : 'ずっと残る',
            100,
          ),
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
                  .map((entry) => {
                    const meta = ITEM_KINDS[entry.kind] ?? ITEM_KINDS.consumable;
                    const amount = isConsumable(entry.kind)
                      ? `使える ${entry.usable} 個（使用済み ${entry.count - entry.usable}）`
                      : `${entry.count} 個`;
                    return `${meta.emoji} **${truncate(entry.name, 40)}** — ${amount}　*(#${entry.item_id})*`;
                  })
                  .join('\n'),
          fields,
        }),
        notice,
      ),
    ],
    components,
  });
}

/** 持ち物のアイテム1種類ぶんの画面。使い切りならここから使う。 */
export async function owned(ix, args, ctx, notice = null) {
  const itemId = Number(args.length > 0 ? args[0] : ix.values[0]);
  const entry = await ownedItem(ctx.db, ix.guildId, ix.userId, itemId);
  if (!entry) return inventory(ix, [], ctx, 'そのアイテムは持っていません。');

  const consumable = isConsumable(entry.kind);
  const usable = consumable ? entry.usable : entry.count;

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: `${(ITEM_KINDS[entry.kind] ?? ITEM_KINDS.consumable).emoji} ${entry.name}`,
          description: consumable
            ? `使い切りのアイテムです。使うと1つ減り、みんなに知らせます。`
            : 'ずっと手元に残るアイテムです。',
          image: entry.image_url ?? undefined,
          fields: [
            { name: '持っている数', value: `${entry.count} 個`, inline: true },
            consumable ? { name: '使える数', value: `${entry.usable} 個`, inline: true } : null,
            { name: '商品番号', value: `#${entry.item_id}`, inline: true },
          ].filter(Boolean),
        }),
        notice,
      ),
    ],
    components: [
      row(
        consumable
          ? button(id('shop', 'use', String(entry.item_id)), '使う', {
              emoji: '✨',
              style: ButtonStyle.SUCCESS,
              disabled: usable <= 0,
            })
          : null,
        button(id('shop', 'view2', String(entry.item_id)), '商品ページ', { emoji: '🔍' }),
      ),
      row(backButton('shop', 'ショップへ'), button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }), homeButton()),
    ],
  });
}

/** 使う前に確かめる。使うとチャンネルに流れて、取り消せないため。 */
export async function use(ix, [rawId], ctx) {
  const itemId = Number(rawId);
  const entry = await ownedItem(ctx.db, ix.guildId, ix.userId, itemId);
  if (!entry || !isConsumable(entry.kind) || entry.usable <= 0) {
    return owned(ix, [String(itemId)], ctx, '使えるものがありませんでした。');
  }
  return show(ix, {
    embeds: [
      embed({
        color: 0x9b59b6,
        title: `✨ ${truncate(entry.name, 80)} を使いますか？`,
        description:
          `使うと1つ減り（あと ${entry.usable - 1} 個）、**チャンネルに「使いました」と流れます**。\n` +
          '出品者にも通知が届きます。使ったあとで取り消すことはできません。',
        thumbnail: entry.image_url ?? undefined,
      }),
    ],
    components: [
      row(
        button(id('shop', 'useok', String(itemId)), '使う', { emoji: '✨', style: ButtonStyle.SUCCESS }),
        button(id('shop', 'owned', String(itemId)), 'やめる', { emoji: '↩️' }),
      ),
    ],
  });
}

export async function useok(ix, [rawId], ctx) {
  const itemId = Number(rawId);
  const used = await useItem(ctx.db, ix.guildId, ix.userId, itemId);
  if (!used) return owned(ix, [String(itemId)], ctx, '使えるものがありませんでした。');

  const item = await getItem(ctx.db, ix.guildId, itemId);
  /** @type {Array<{name: string, value: string, inline?: boolean}>} */
  const fields = [{ name: '商品番号', value: `#${itemId}`, inline: true }];
  if (item?.seller_id) fields.push({ name: '出品者', value: `<@${item.seller_id}>`, inline: true });
  if (item?.description) fields.push({ name: '説明', value: truncate(item.description, 400) });

  // embed の中のメンションは通知が鳴らないので、出品者は本文に書く
  const hasSeller = Boolean(item?.seller_id) && item.seller_id !== 'deleted';
  ctx.announce(ix.channelId, {
    content: hasSeller ? `<@${item.seller_id}> さん、出番です` : '',
    embeds: [
      embed({
        color: 0x9b59b6,
        author: { name: ix.displayName, icon_url: ix.avatar },
        title: `✨ ${truncate(used.name, 80)} を使いました！`,
        description: `<@${ix.userId}> が使いました。`,
        image: used.image_url ?? undefined,
        fields,
        footer: { text: hasSeller ? '受け渡しが済んだら、出品者が「対応した」を押してください' : '受け渡しは当人同士でどうぞ' },
      }),
    ],
    components: hasSeller
      ? [row(button(`${PUBLIC_PREFIX}:done:${used.id}`, '対応した（出品者用）', { emoji: '✅' }))]
      : [],
    allowed_mentions: hasSeller ? { users: [item.seller_id] } : { parse: [] },
  });

  return owned(ix, [String(itemId)], ctx, `**${used.name}** を使いました！ チャンネルにも知らせました`);
}

export const actions = {
  open,
  search,
  find,
  pending,
  deliver,
  view,
  view2,
  confirm,
  buy,
  sell,
  sellform,
  create,
  kind,
  owned,
  use,
  useok,
  mine,
  manage,
  manage2,
  edit,
  update,
  remove,
  inventory,
};
