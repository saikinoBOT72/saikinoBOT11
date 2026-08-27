import {
  EmbedBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getBalance, getSettings } from '../lib/economy.js';
import { coins, truncate } from '../lib/format.js';
import { deleteImage, imagePayload, isValidImageUrl } from '../lib/images.js';
import {
  ShopError,
  createItem,
  countItems,
  deactivateItem,
  getItem,
  inventoryOf,
  listItems,
  purchase,
  salesOf,
  updateItem,
} from '../lib/shop.js';
import { announce, backButton, button, homeButton, id, isError, readInt, readText, row, show, toast } from './common.js';
import { awaitImage, uploadHint } from './upload.js';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ 一覧 */

export async function open(interaction, [rawPage = '0'] = []) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const page = Math.max(0, Number(rawPage) || 0);
  const total = countItems(guildId);
  const items = listItems(guildId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const balance = getBalance(guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('🛍️ ショップ')
    .setDescription(
      items.length === 0
        ? 'まだ出品がありません。**🆕 出品する** から、値段と画像を決めて出品できます。'
        : `所持金 ${coins(balance, settings)}\n\n` +
            items
              .map((item) => {
                const stock = item.stock < 0 ? '在庫∞' : `残り${item.stock}`;
                return `**#${item.id} ${truncate(item.name, 40)}** — ${settings.currency_emoji}${item.price.toLocaleString('ja-JP')}　*(${stock}・<@${item.seller_id}>)*`;
              })
              .join('\n'),
    )
    .setFooter({ text: `全 ${total} 件${total > PAGE_SIZE ? `／${page + 1} ページ目` : ''}` });

  const components = [];
  if (items.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(id('shop', 'view'))
      .setPlaceholder('アイテムを選んで詳細を見る')
      .addOptions(
        items.map((item) => ({
          label: truncate(`#${item.id} ${item.name}`, 100),
          value: String(item.id),
          description: truncate(
            `${settings.currency_emoji}${item.price} / ${item.stock < 0 ? '在庫無制限' : `残り${item.stock}`}`,
            100,
          ),
        })),
      );
    components.push(row(select));
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
      button(id('shop', 'sell'), '出品する', { emoji: '🆕', style: ButtonStyle.Success }),
      button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }),
      button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }),
    ),
    row(backButton()),
  );

  return show(interaction, { embeds: [embed], components });
}

/* ------------------------------------------------------------------ 詳細・購入 */

export async function view(interaction) {
  return detail(interaction, Number(interaction.values[0]));
}

async function detail(interaction, itemId, notice = null) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, itemId);
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');

  const balance = getBalance(interaction.guildId, interaction.user.id);
  const { url, files } = imagePayload(item);
  const isSeller = item.seller_id === interaction.user.id;
  const affordable = balance >= item.price;

  const embed = new EmbedBuilder()
    .setColor(item.active ? 0x1abc9c : 0x95a5a6)
    .setTitle(`#${item.id} ${item.name}`)
    .addFields(
      { name: '価格', value: coins(item.price, settings), inline: true },
      { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock}`, inline: true },
      { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
      { name: '所持金', value: coins(balance, settings), inline: true },
    );
  if (item.description) embed.setDescription(item.description);
  if (url) embed.setImage(url);
  if (notice) embed.addFields({ name: 'お知らせ', value: notice });
  if (!item.active) embed.setFooter({ text: 'この出品は現在停止中です' });
  else if (isSeller) embed.setFooter({ text: '自分の出品は購入できません' });
  else if (!affordable) embed.setFooter({ text: '所持金が足りません' });

  return show(interaction, {
    embeds: [embed],
    files,
    components: [
      row(
        button(id('shop', 'confirm', String(item.id)), '購入する', {
          emoji: '💳',
          style: ButtonStyle.Success,
          disabled: isSeller || !affordable || !item.active,
        }),
        isSeller ? button(id('shop', 'manage', String(item.id)), 'この出品を管理', { emoji: '🔧' }) : null,
      ),
      row(backButton('shop', '一覧へ'), homeButton()),
    ],
  });
}

export async function confirm(interaction, [rawId]) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  const balance = getBalance(interaction.guildId, interaction.user.id);

  const { url, files } = imagePayload(item);
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('本当に買いますか？')
    .setDescription(`**${item.name}** を ${coins(item.price, settings)} で購入します。`)
    .addFields(
      { name: '購入後の所持金', value: coins(balance - item.price, settings), inline: true },
      { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
    );
  if (url) embed.setThumbnail(url);

  return show(interaction, {
    embeds: [embed],
    files,
    components: [
      row(
        button(id('shop', 'buy', String(item.id)), '購入する', { emoji: '✅', style: ButtonStyle.Success }),
        button(id('shop', 'view2', String(item.id)), 'やめる', { emoji: '↩️' }),
      ),
    ],
  });
}

export async function view2(interaction, [rawId]) {
  return detail(interaction, Number(rawId));
}

export async function buy(interaction, [rawId]) {
  const settings = getSettings(interaction.guildId);
  let item;
  try {
    item = purchase(interaction.guildId, Number(rawId), interaction.user.id);
  } catch (error) {
    if (error instanceof ShopError) {
      await toast(interaction, error.message);
      return open(interaction);
    }
    throw error;
  }

  const balance = getBalance(interaction.guildId, interaction.user.id);
  const { url, files } = imagePayload(item);

  const announcement = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('🧾 購入がありました')
    .setDescription(
      `<@${interaction.user.id}> が <@${item.seller_id}> の **${item.name}** を ${coins(item.price, settings)} で購入しました。`,
    );
  if (url) announcement.setThumbnail(url);
  await announce(interaction, { embeds: [announcement], files, allowedMentions: { users: [item.seller_id] } });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ 購入しました')
    .setDescription(`**${item.name}** を手に入れました。\n所持金は ${coins(balance, settings)} です。`)
    .setFooter({ text: '出品者に代金が渡りました。受け渡しは当人同士でどうぞ' });

  return show(interaction, {
    embeds: [embed],
    components: [row(button(id('shop', 'open'), 'ショップに戻る', { emoji: '🛍️' }), button(id('shop', 'inventory'), '持ち物', { emoji: '🎒' }), homeButton())],
  });
}

/* ------------------------------------------------------------------ 出品 */

export async function sell(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(id('shop', 'create'))
    .setTitle('アイテムを出品する')
    .addComponents(
      textRow('name', 'アイテム名', { placeholder: '例: 肩たたき券', required: true, max: 60 }),
      textRow('price', '価格', { placeholder: '例: 500', required: true, max: 12 }),
      textRow('description', '説明（任意）', { style: TextInputStyle.Paragraph, max: 400 }),
      textRow('stock', '在庫数（空欄なら無制限）', { placeholder: '例: 3', max: 6 }),
      textRow('image_url', '画像URL（任意・あとから画像も送れます）', { max: 300 }),
    );
  return interaction.showModal(modal);
}

export async function create(interaction) {
  const name = readText(interaction, 'name');
  const price = readInt(interaction, 'price', { min: 0 });
  const stock = readInt(interaction, 'stock', { min: 1, fallback: -1 });
  const imageUrl = readText(interaction, 'image_url');

  if (!name) return toast(interaction, 'アイテム名を入力してください。');
  if (isError(price)) return toast(interaction, price.error);
  if (isError(stock)) return toast(interaction, stock.error);
  if (imageUrl && !isValidImageUrl(imageUrl)) return toast(interaction, '画像URLは http(s) から始まるURLを入力してください。');

  const item = createItem({
    guildId: interaction.guildId,
    sellerId: interaction.user.id,
    name,
    description: readText(interaction, 'description'),
    price,
    imageUrl,
    imageFile: null,
    stock,
  });

  return manage(interaction, [String(item.id)], '出品しました！ 画像を付けると目を引きます。');
}

/* ------------------------------------------------------------------ 自分の出品の管理 */

export async function mine(interaction) {
  const settings = getSettings(interaction.guildId);
  const items = listItems(interaction.guildId, { sellerId: interaction.user.id, includeInactive: true, limit: 25 });
  const sales = salesOf(interaction.guildId, interaction.user.id);
  const revenue = sales.reduce((sum, r) => sum + r.total, 0);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('📦 自分の出品')
    .setDescription(
      items.length === 0
        ? 'まだ出品していません。**🆕 出品する** から始められます。'
        : items
            .map((item) => {
              const state = item.active ? (item.stock < 0 ? '在庫∞' : `残り${item.stock}`) : '停止中';
              return `**#${item.id} ${truncate(item.name, 40)}** — ${settings.currency_emoji}${item.price}　*(${state}・${item.sold}個売れた)*`;
            })
            .join('\n'),
    );
  if (revenue > 0) embed.addFields({ name: '売上合計', value: coins(revenue, settings), inline: true });

  const components = [];
  if (items.length > 0) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('shop', 'manage2'))
          .setPlaceholder('編集する出品を選ぶ')
          .addOptions(
            items.map((item) => ({
              label: truncate(`#${item.id} ${item.name}`, 100),
              value: String(item.id),
              description: truncate(`${settings.currency_emoji}${item.price} / ${item.active ? '販売中' : '停止中'}`, 100),
            })),
          ),
      ),
    );
  }
  components.push(
    row(button(id('shop', 'sell'), '出品する', { emoji: '🆕', style: ButtonStyle.Success }), backButton('shop', 'ショップへ'), homeButton()),
  );

  return show(interaction, { embeds: [embed], components });
}

export async function manage2(interaction) {
  return manage(interaction, [interaction.values[0]]);
}

export async function manage(interaction, [rawId], notice = null) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== interaction.user.id) return toast(interaction, '自分の出品だけ編集できます。');

  const { url, files } = imagePayload(item);
  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`🔧 #${item.id} ${item.name}`)
    .addFields(
      { name: '価格', value: coins(item.price, settings), inline: true },
      { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock}`, inline: true },
      { name: '売れた数', value: `${item.sold}`, inline: true },
      { name: '状態', value: item.active ? '販売中' : '停止中', inline: true },
    );
  if (item.description) embed.setDescription(item.description);
  if (url) embed.setImage(url);
  if (notice) embed.setFooter({ text: notice });

  return show(interaction, {
    embeds: [embed],
    files,
    components: [
      row(
        button(id('shop', 'edit', String(item.id)), '内容を編集', { emoji: '✏️', style: ButtonStyle.Primary }),
        button(id('shop', 'photo', String(item.id)), url ? '画像を変える' : '画像を付ける', { emoji: '🖼️' }),
        button(id('shop', 'remove', String(item.id)), item.active ? '取り下げる' : '再開する', {
          emoji: item.active ? '🗑️' : '♻️',
          style: item.active ? ButtonStyle.Danger : ButtonStyle.Success,
        }),
      ),
      row(backButton('shop', 'ショップへ'), button(id('shop', 'mine'), '自分の出品', { emoji: '📦' }), homeButton()),
    ],
  });
}

export async function edit(interaction, [rawId]) {
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== interaction.user.id) return toast(interaction, '自分の出品だけ編集できます。');

  const modal = new ModalBuilder()
    .setCustomId(id('shop', 'update', String(item.id)))
    .setTitle(`#${item.id} を編集`)
    .addComponents(
      textRow('name', 'アイテム名', { required: true, max: 60, value: item.name }),
      textRow('price', '価格', { required: true, max: 12, value: String(item.price) }),
      textRow('description', '説明（任意）', { style: TextInputStyle.Paragraph, max: 400, value: item.description ?? '' }),
      textRow('stock', '在庫数（空欄なら無制限）', { max: 6, value: item.stock < 0 ? '' : String(item.stock) }),
    );
  return interaction.showModal(modal);
}

export async function update(interaction, [rawId]) {
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== interaction.user.id) return toast(interaction, '自分の出品だけ編集できます。');

  const name = readText(interaction, 'name');
  const price = readInt(interaction, 'price', { min: 0 });
  const stock = readInt(interaction, 'stock', { min: 0, fallback: -1 });
  if (!name) return toast(interaction, 'アイテム名を入力してください。');
  if (isError(price)) return toast(interaction, price.error);
  if (isError(stock)) return toast(interaction, stock.error);

  updateItem(interaction.guildId, item.id, {
    name,
    price,
    description: readText(interaction, 'description'),
    stock,
    active: stock === 0 ? 0 : 1,
  });

  return manage(interaction, [String(item.id)], '内容を更新しました');
}

export async function photo(interaction, [rawId]) {
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== interaction.user.id) return toast(interaction, '自分の出品だけ編集できます。');

  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`🖼️ #${item.id} ${item.name} の画像`)
    .setDescription(`${uploadHint(interaction.client)}\n\n*3分以内に送ってください。*`);
  await show(interaction, { embeds: [embed], components: [] });

  const uploaded = await awaitImage(interaction);
  if (uploaded.error) return manage(interaction, [String(item.id)], uploaded.error);

  const previous = item.image_file;
  updateItem(interaction.guildId, item.id, { image_file: uploaded.file, image_url: null });
  if (previous) deleteImage(previous);
  return manage(interaction, [String(item.id)], '画像を設定しました');
}

export async function remove(interaction, [rawId]) {
  const item = getItem(interaction.guildId, Number(rawId));
  if (!item) return toast(interaction, 'そのアイテムは見つかりませんでした。');
  if (item.seller_id !== interaction.user.id) return toast(interaction, '自分の出品だけ操作できます。');

  if (item.active) {
    deactivateItem(interaction.guildId, item.id);
    return manage(interaction, [String(item.id)], '出品を取り下げました');
  }
  updateItem(interaction.guildId, item.id, { active: 1, stock: item.stock === 0 ? -1 : item.stock });
  return manage(interaction, [String(item.id)], '販売を再開しました');
}

/* ------------------------------------------------------------------ 持ち物 */

export async function inventory(interaction) {
  const settings = getSettings(interaction.guildId);
  const owned = inventoryOf(interaction.guildId, interaction.user.id);
  const sales = salesOf(interaction.guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setAuthor({
      name: interaction.member?.displayName ?? interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTitle('🎒 持ち物');

  if (owned.length === 0) {
    embed.setDescription('まだ何も持っていません。ショップを覗いてみましょう。');
  } else {
    embed.setDescription(
      owned
        .slice(0, 20)
        .map((r) => `• **${truncate(r.name, 40)}** ×${r.count}　*(#${r.item_id}・計 ${settings.currency_emoji}${r.total})*`)
        .join('\n'),
    );
    embed.addFields({
      name: '購入合計',
      value: coins(owned.reduce((sum, r) => sum + r.total, 0), settings),
      inline: true,
    });
  }
  if (sales.length > 0) {
    embed.addFields({
      name: '売上合計',
      value: coins(sales.reduce((sum, r) => sum + r.total, 0), settings),
      inline: true,
    });
  }

  const components = [];
  if (owned.length > 0) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('shop', 'view'))
          .setPlaceholder('持っているアイテムを見る')
          .addOptions(
            owned.slice(0, 25).map((r) => ({
              label: truncate(`#${r.item_id} ${r.name}`, 100),
              value: String(r.item_id),
              description: `×${r.count}`,
            })),
          ),
      ),
    );
  }
  components.push(row(button(id('shop', 'open'), 'ショップへ', { emoji: '🛍️' }), homeButton()));

  return show(interaction, { embeds: [embed], components });
}

function textRow(customId, label, { style = TextInputStyle.Short, placeholder, required = false, max, value } = {}) {
  const input = new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (max) input.setMaxLength(max);
  if (value) input.setValue(value);
  return new ActionRowBuilder().addComponents(input);
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
  photo,
  remove,
  inventory,
};
