import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getSettings, getBalance } from '../lib/economy.js';
import { coins, truncate } from '../lib/format.js';
import { ImageError, deleteImage, imagePayload, isValidImageUrl, saveAttachment } from '../lib/images.js';
import {
  ShopError,
  createItem,
  countItems,
  deactivateItem,
  getItem,
  listItems,
  purchase,
  recentBuyers,
  updateItem,
} from '../lib/shop.js';

export const namespace = 'shop';

const PAGE_SIZE = 8;

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('メンバー同士でアイテムを売り買いする')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('sell')
      .setDescription('アイテムを出品する')
      .addStringOption((o) => o.setName('name').setDescription('アイテム名').setRequired(true).setMaxLength(60))
      .addIntegerOption((o) => o.setName('price').setDescription('価格').setRequired(true).setMinValue(0))
      .addAttachmentOption((o) => o.setName('image').setDescription('アイテム画像（アップロード）'))
      .addStringOption((o) => o.setName('image_url').setDescription('アイテム画像のURL（アップロードの代わりに）'))
      .addStringOption((o) => o.setName('description').setDescription('説明文').setMaxLength(400))
      .addIntegerOption((o) => o.setName('stock').setDescription('在庫数（未指定なら無制限）').setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('出品中のアイテム一覧を見る')
      .addIntegerOption((o) => o.setName('page').setDescription('ページ番号').setMinValue(1))
      .addUserOption((o) => o.setName('seller').setDescription('出品者で絞り込む')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('アイテムの詳細と画像を見る')
      .addIntegerOption((o) => o.setName('id').setDescription('アイテム番号').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('buy')
      .setDescription('アイテムを買う')
      .addIntegerOption((o) => o.setName('id').setDescription('アイテム番号').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('自分の出品を編集する')
      .addIntegerOption((o) => o.setName('id').setDescription('アイテム番号').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('price').setDescription('新しい価格').setMinValue(0))
      .addStringOption((o) => o.setName('description').setDescription('新しい説明文').setMaxLength(400))
      .addIntegerOption((o) => o.setName('stock').setDescription('新しい在庫数（0で販売停止）').setMinValue(0))
      .addAttachmentOption((o) => o.setName('image').setDescription('新しい画像')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('出品を取り下げる（自分の出品／管理者は全て）')
      .addIntegerOption((o) => o.setName('id').setDescription('アイテム番号').setRequired(true).setAutocomplete(true)),
  );

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const sub = interaction.options.getSubcommand();
  const mineOnly = sub === 'edit' || sub === 'remove';
  const items = listItems(interaction.guildId, {
    includeInactive: mineOnly,
    sellerId: mineOnly ? interaction.user.id : null,
    limit: 100,
  });
  const choices = items
    .filter((item) => {
      if (!focused) return true;
      return item.name.toLowerCase().includes(focused) || String(item.id).includes(focused);
    })
    .slice(0, 25)
    .map((item) => ({ name: truncate(`#${item.id} ${item.name} — ${item.price}`, 100), value: item.id }));
  await interaction.respond(choices);
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'sell') return handleSell(interaction);
  if (sub === 'list') return handleList(interaction);
  if (sub === 'show') return handleShow(interaction);
  if (sub === 'buy') return handleBuy(interaction);
  if (sub === 'edit') return handleEdit(interaction);
  return handleRemove(interaction);
}

async function handleSell(interaction) {
  const settings = getSettings(interaction.guildId);
  const attachment = interaction.options.getAttachment('image');
  const imageUrl = interaction.options.getString('image_url');

  if (imageUrl && !isValidImageUrl(imageUrl)) {
    await interaction.reply({ content: '画像URLは http(s) から始まるURLを指定してください。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  let imageFile = null;
  if (attachment) {
    try {
      imageFile = await saveAttachment(attachment);
    } catch (error) {
      if (error instanceof ImageError) {
        await interaction.editReply({ content: error.message });
        return;
      }
      throw error;
    }
  }

  const stock = interaction.options.getInteger('stock');
  const item = createItem({
    guildId: interaction.guildId,
    sellerId: interaction.user.id,
    name: interaction.options.getString('name').trim(),
    description: interaction.options.getString('description'),
    price: interaction.options.getInteger('price'),
    imageUrl: imageFile ? null : imageUrl,
    imageFile,
    stock: stock ?? -1,
  });

  const { embed, files } = itemEmbed(item, settings, interaction);
  embed.setTitle(`🛒 出品しました: ${item.name}`);
  await interaction.editReply({ embeds: [embed], files });
}

async function handleList(interaction) {
  const settings = getSettings(interaction.guildId);
  const seller = interaction.options.getUser('seller');
  const page = interaction.options.getInteger('page') ?? 1;
  const items = listItems(interaction.guildId, {
    sellerId: seller?.id ?? null,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  if (items.length === 0) {
    await interaction.reply({
      content: page > 1 ? 'そのページには出品がありません。' : 'まだ出品がありません。`/shop sell` で出品してみましょう。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const total = seller ? items.length : countItems(interaction.guildId);
  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('🛍️ ショップ')
    .setDescription(
      items
        .map((item) => {
          const stock = item.stock < 0 ? '在庫∞' : `残り${item.stock}`;
          const desc = item.description ? `\n　　${truncate(item.description, 60)}` : '';
          return `**#${item.id} ${item.name}** — ${settings.currency_emoji} ${item.price.toLocaleString('ja-JP')}　*(${stock} / 出品者 <@${item.seller_id}>)*${desc}`;
        })
        .join('\n'),
    )
    .setFooter({
      text: seller
        ? `${seller.displayName ?? seller.username} の出品`
        : `${page} ページ目 / 全 ${Math.max(1, Math.ceil(total / PAGE_SIZE))} ページ・全 ${total} 件`,
    });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleShow(interaction) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, interaction.options.getInteger('id'));
  if (!item) {
    await interaction.reply({ content: 'そのアイテムは見つかりませんでした。', flags: MessageFlags.Ephemeral });
    return;
  }
  const { embed, files } = itemEmbed(item, settings, interaction);
  const buyers = recentBuyers(interaction.guildId, item.id, 5);
  if (buyers.length > 0) {
    embed.addFields({ name: '最近の購入者', value: buyers.map((b) => `<@${b.buyer_id}>`).join(' ') });
  }
  await interaction.reply({ embeds: [embed], files, allowedMentions: { parse: [] } });
}

async function handleBuy(interaction) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, interaction.options.getInteger('id'));
  if (!item || !item.active) {
    await interaction.reply({ content: 'そのアイテムは購入できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (item.seller_id === interaction.user.id) {
    await interaction.reply({ content: '自分の出品は購入できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  const balance = getBalance(interaction.guildId, interaction.user.id);
  if (balance < item.price) {
    await interaction.reply({
      content: `残高が足りません。必要 ${coins(item.price, settings)} / 所持 ${coins(balance, settings)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { embed, files } = itemEmbed(item, settings, interaction);
  embed.setTitle(`購入確認: ${item.name}`).setFooter({ text: `購入後の所持金: ${balance - item.price}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop:confirm:${item.id}`).setLabel('購入する').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:cancel:0').setLabel('やめる').setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ embeds: [embed], files, components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleComponent(interaction) {
  const [, action, rawId] = interaction.customId.split(':');
  if (action === 'cancel') {
    await interaction.update({ content: '購入をキャンセルしました。', embeds: [], components: [], files: [] });
    return;
  }
  if (action !== 'confirm') return;

  const settings = getSettings(interaction.guildId);
  const itemId = Number(rawId);
  let item;
  try {
    item = purchase(interaction.guildId, itemId, interaction.user.id);
  } catch (error) {
    if (error instanceof ShopError) {
      await interaction.update({ content: error.message, embeds: [], components: [], files: [] });
      return;
    }
    throw error;
  }

  const balance = getBalance(interaction.guildId, interaction.user.id);
  await interaction.update({
    content: `✅ **${item.name}** を購入しました。所持金は ${coins(balance, settings)} です。`,
    embeds: [],
    components: [],
    files: [],
  });

  const { url, files } = imagePayload(item);
  const announce = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('🧾 購入がありました')
    .setDescription(
      `<@${interaction.user.id}> が <@${item.seller_id}> の **${item.name}** を ${coins(item.price, settings)} で購入しました。`,
    );
  if (url) announce.setThumbnail(url);

  // 確認メッセージは本人にしか見えないので、購入の告知はチャンネルに直接投稿する
  const payload = { embeds: [announce], files, allowedMentions: { users: [item.seller_id] } };
  if (interaction.channel?.isSendable()) await interaction.channel.send(payload);
  else await interaction.followUp(payload);
}

async function handleEdit(interaction) {
  const settings = getSettings(interaction.guildId);
  const item = getItem(interaction.guildId, interaction.options.getInteger('id'));
  if (!item) {
    await interaction.reply({ content: 'そのアイテムは見つかりませんでした。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (item.seller_id !== interaction.user.id) {
    await interaction.reply({ content: '自分の出品だけ編集できます。', flags: MessageFlags.Ephemeral });
    return;
  }

  const price = interaction.options.getInteger('price');
  const description = interaction.options.getString('description');
  const stock = interaction.options.getInteger('stock');
  const attachment = interaction.options.getAttachment('image');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const patch = {};
  if (price !== null) patch.price = price;
  if (description !== null) patch.description = description;
  if (stock !== null) {
    patch.stock = stock;
    patch.active = stock === 0 ? 0 : 1;
  }
  if (attachment) {
    try {
      patch.image_file = await saveAttachment(attachment);
      patch.image_url = null;
    } catch (error) {
      if (error instanceof ImageError) {
        await interaction.editReply({ content: error.message });
        return;
      }
      throw error;
    }
    deleteImage(item.image_file);
  }

  if (Object.keys(patch).length === 0) {
    await interaction.editReply({ content: '変更する項目を指定してください。' });
    return;
  }

  const updated = updateItem(interaction.guildId, item.id, patch);

  const { embed, files } = itemEmbed(updated, settings, interaction);
  embed.setTitle(`✏️ 更新しました: ${updated.name}`);
  await interaction.editReply({ embeds: [embed], files });
}

async function handleRemove(interaction) {
  const item = getItem(interaction.guildId, interaction.options.getInteger('id'));
  if (!item) {
    await interaction.reply({ content: 'そのアイテムは見つかりませんでした。', flags: MessageFlags.Ephemeral });
    return;
  }
  const isManager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (item.seller_id !== interaction.user.id && !isManager) {
    await interaction.reply({ content: '自分の出品だけ取り下げできます。', flags: MessageFlags.Ephemeral });
    return;
  }
  deactivateItem(interaction.guildId, item.id);
  await interaction.reply({ content: `**${item.name}**（#${item.id}）を取り下げました。`, flags: MessageFlags.Ephemeral });
}

function itemEmbed(item, settings, interaction) {
  const { url, files } = imagePayload(item);
  const seller = interaction.guild.members.cache.get(item.seller_id);
  const embed = new EmbedBuilder()
    .setColor(item.active ? 0x1abc9c : 0x95a5a6)
    .setTitle(`#${item.id} ${item.name}`)
    .addFields(
      { name: '価格', value: coins(item.price, settings), inline: true },
      { name: '在庫', value: item.stock < 0 ? '無制限' : `${item.stock}`, inline: true },
      { name: '販売数', value: `${item.sold}`, inline: true },
      { name: '出品者', value: `<@${item.seller_id}>`, inline: true },
    );
  if (item.description) embed.setDescription(item.description);
  if (!item.active) embed.setFooter({ text: 'この出品は現在停止中です' });
  if (url) embed.setImage(url);
  if (seller) embed.setThumbnail(seller.displayAvatarURL());
  return { embed, files };
}
