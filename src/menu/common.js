import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';

/** メニューの customId は `m:<画面>:<操作>:<引数...>` の形式にする。 */
export const MENU_PREFIX = 'm';

export function id(...parts) {
  return [MENU_PREFIX, ...parts].join(':');
}

/**
 * メニュー画面を描き直す。
 * ボタン／セレクト／（メッセージから開いた）モーダルは元のメッセージを編集し、
 * それ以外は新しく本人だけに見えるメッセージを出す。
 */
export async function show(interaction, payload) {
  const data = { content: '', embeds: [], components: [], files: [], ...payload };
  // 編集時は attachments: [] を渡して、前の画面で貼った画像を消す
  if (interaction.deferred || interaction.replied) return interaction.editReply({ ...data, attachments: [] });
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
    return interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
  }
  if (interaction.isChatInputCommand()) return interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
  return interaction.update({ ...data, attachments: [] });
}

/** 画面はそのままに、短いお知らせだけ本人に出す。 */
export async function toast(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export function button(customId, label, { style = ButtonStyle.Secondary, emoji, disabled = false } = {}) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function row(...components) {
  return new ActionRowBuilder().addComponents(...components.filter(Boolean));
}

export function backButton(target = 'home', label = '戻る') {
  return button(id(target, 'open'), label, { emoji: '◀️' });
}

export function homeButton() {
  return button(id('home', 'open'), 'メニュー', { emoji: '🏠' });
}

/** 賭け金・金額を選ぶボタン列。所持金で足りないものは押せなくする。 */
export const AMOUNT_PRESETS = [10, 50, 100, 500, 1000];

export function amountRows(prefix, balance, { extra = [], maxBet = 0 } = {}) {
  const presets = AMOUNT_PRESETS.filter((amount) => maxBet <= 0 || amount <= maxBet);
  const buttons = presets.map((amount) =>
    button(id(...prefix, String(amount)), amount.toLocaleString('ja-JP'), {
      style: ButtonStyle.Primary,
      disabled: balance < amount,
    }),
  );
  return [row(...buttons), row(button(id(...prefix, 'custom'), '金額を入力', { emoji: '⌨️' }), ...extra)];
}

/** モーダルの入力を整数として読む。読めなければ {error} を返す。 */
export function readInt(interaction, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const raw = interaction.fields.getTextInputValue(field).trim();
  if (raw === '') return fallback;
  const normalized = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，\s]/g, '');
  if (!/^-?\d+$/.test(normalized)) return { error: `「${raw}」は数字として読めませんでした。` };
  const value = Number(normalized);
  if (value < min || value > max) return { error: `${min} 〜 ${max} の範囲で入力してください（入力: ${value}）。` };
  return value;
}

export function isError(value) {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** モーダルの任意テキスト（空欄なら null）。 */
export function readText(interaction, field) {
  const value = interaction.fields.getTextInputValue(field).trim();
  return value === '' ? null : value;
}

/** チャンネルへの公開投稿。権限が無ければ黙って諦める。 */
export async function announce(interaction, payload) {
  try {
    if (interaction.channel?.isSendable()) await interaction.channel.send(payload);
  } catch (error) {
    console.error('公開メッセージの送信に失敗:', error);
  }
}
