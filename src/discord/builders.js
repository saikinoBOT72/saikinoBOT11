import { ButtonStyle, ComponentType, TextInputStyle } from './constants.js';

/** undefined のキーを落として、Discord に送る JSON を作る。 */
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * @param {{color?: number, title?: string, description?: string, fields?: Array<object|null|false>,
 *   author?: object, footer?: object, image?: string, thumbnail?: string}} [parts]
 */
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

/**
 * @param {string} customId
 * @param {string} [label]
 * @param {{style?: number, emoji?: string, disabled?: boolean}} [options]
 */
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

/**
 * 押すとURLを開くボタン。custom_id を持たないので、押しても Bot には届かない。
 * 「元のメッセージへ飛ぶ」のような案内に使う。
 */
/**
 * @param {string} url
 * @param {string} label
 * @param {{emoji?: string}} [options]
 */
export function linkButton(url, label, { emoji } = {}) {
  return compact({
    type: ComponentType.BUTTON,
    style: ButtonStyle.LINK,
    url,
    label,
    emoji: toEmoji(emoji),
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

/**
 * @param {string} customId
 * @param {string} label
 * @param {{style?: number, placeholder?: string, value?: string, required?: boolean, max?: number}} [options]
 */
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

/**
 * 入力フォーム。
 * labeled: true なら、Discord が今すすめている形（Label の中に入力欄を入れる形）で作る。
 * この形でしか置けない部品（フォームの中の選択リストなど）を使うときは必須。
 * 古い Discord アプリでは開けないことがあるので、管理メニューの「新しい見た目」がオンのときだけ使う。
 */
export function modal(customId, title, inputs, { labeled = false } = {}) {
  const components = inputs.filter(Boolean);
  return { custom_id: customId, title, components: labeled ? components.map(toLabel) : components };
}

/** 行に入った入力欄（古い形）を Label の形に直す。もう Label ならそのまま。 */
function toLabel(component) {
  if (component.type === ComponentType.LABEL) return component;
  const inner = component.components?.[0];
  if (!inner) return component;
  const { label, ...rest } = inner;
  return { type: ComponentType.LABEL, label: String(label ?? '').slice(0, 45), component: rest };
}

/** フォームの中の選択リスト（Label の形でしか置けない）。 */
/**
 * @param {string} customId
 * @param {string} label
 * @param {Array<{label: string, value: string, description?: string, emoji?: string, default?: boolean}>} options
 * @param {{description?: string, placeholder?: string, required?: boolean}} [settings]
 */
export function selectField(customId, label, options, { description, placeholder, required = true } = {}) {
  return compact({
    type: ComponentType.LABEL,
    label: label.slice(0, 45),
    description: description?.slice(0, 100),
    component: compact({
      type: ComponentType.STRING_SELECT,
      custom_id: customId,
      placeholder,
      required,
      options: options.slice(0, 25).map((option) =>
        compact({
          label: option.label,
          value: String(option.value),
          description: option.description,
          emoji: toEmoji(option.emoji),
          default: option.default || undefined,
        }),
      ),
    }),
  });
}

/** フォームの中のメンバー選択。 */
/**
 * @param {string} customId
 * @param {string} label
 * @param {{description?: string, required?: boolean}} [settings]
 */
export function userField(customId, label, { description, required = true } = {}) {
  return compact({
    type: ComponentType.LABEL,
    label: label.slice(0, 45),
    description: description?.slice(0, 100),
    component: { type: ComponentType.USER_SELECT, custom_id: customId, max_values: 1, required },
  });
}

/** ユーザーのアイコンURL。 */
export function avatarUrl(user) {
  if (!user) return undefined;
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  // アイコン未設定の人には Discord 既定のアイコンを出す
  let index;
  try {
    index = (BigInt(user.id) >> 22n) % 6n;
  } catch {
    index = 0n;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
