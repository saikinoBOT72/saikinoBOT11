import { ButtonStyle, ComponentType, TextInputStyle } from './constants.js';

/** undefined のキーを落として、Discord に送る JSON を作る。 */
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

export function embed({ color, title, description, fields, author, footer, image, thumbnail } = {}) {
  return compact({
    color,
    title,
    description,
    fields: fields?.filter(Boolean),
    author,
    footer,
    image: image ? { url: image } : undefined,
    thumbnail: thumbnail ? { url: thumbnail } : undefined,
  });
}

/** 絵文字は「😀」でも「<:name:id>」でも受け取れるようにする。 */
function toEmoji(emoji) {
  if (!emoji) return undefined;
  const custom = /^<(a?):(\w+):(\d+)>$/.exec(emoji);
  if (custom) return { name: custom[2], id: custom[3], animated: custom[1] === 'a' };
  return { name: emoji };
}

export function button(customId, label, { style = ButtonStyle.SECONDARY, emoji, disabled = false } = {}) {
  return compact({
    type: ComponentType.BUTTON,
    custom_id: customId,
    label,
    style,
    emoji: toEmoji(emoji),
    disabled: disabled || undefined,
  });
}

export function row(...components) {
  return { type: ComponentType.ACTION_ROW, components: components.filter(Boolean) };
}

export function stringSelect(customId, placeholder, options) {
  return row({
    type: ComponentType.STRING_SELECT,
    custom_id: customId,
    placeholder,
    options: options.slice(0, 25).map((option) =>
      compact({
        label: option.label,
        value: String(option.value),
        description: option.description,
        emoji: toEmoji(option.emoji),
      }),
    ),
  });
}

export function userSelect(customId, placeholder) {
  return row({ type: ComponentType.USER_SELECT, custom_id: customId, placeholder, max_values: 1 });
}

/** テキストチャンネルだけ選べるメニュー。 */
export function channelSelect(customId, placeholder) {
  return row({
    type: ComponentType.CHANNEL_SELECT,
    custom_id: customId,
    placeholder,
    max_values: 1,
    channel_types: [0, 5], // 0=テキスト 5=アナウンス
  });
}

export function textInput(customId, label, { style = TextInputStyle.SHORT, placeholder, value, required = false, max } = {}) {
  return row(
    compact({
      type: ComponentType.TEXT_INPUT,
      custom_id: customId,
      label,
      style,
      placeholder,
      value: value || undefined,
      required,
      max_length: max,
    }),
  );
}

export function modal(customId, title, inputs) {
  return { custom_id: customId, title, components: inputs };
}

/** ユーザーのアイコンURL。 */
export function avatarUrl(user) {
  if (!user) return undefined;
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  // アイコン未設定の人には Discord 既定のアイコンを出す
  let index = 0n;
  try {
    index = (BigInt(user.id) >> 22n) % 6n;
  } catch {
    index = 0n;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
