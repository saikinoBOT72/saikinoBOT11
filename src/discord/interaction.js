import { ADMIN_PERMISSIONS, InteractionType } from './constants.js';
import { avatarUrl } from './builders.js';

/** Discord から届いた JSON を扱いやすくする薄い包み。 */
/**
 * フォームで送られた部品を探す。
 * 古い形（行の中に入力欄）と新しい形（Label の中に入力欄）のどちらでも読める。
 */
function formComponent(raw, customId) {
  for (const top of raw.data?.components ?? []) {
    const inner = top.component ? [top.component] : (top.components ?? []);
    for (const component of inner) {
      if (component.custom_id === customId) return component;
    }
  }
  return null;
}

export class Ix {
  constructor(raw) {
    this.raw = raw;
  }

  get type() {
    return this.raw.type;
  }

  get guildId() {
    return this.raw.guild_id;
  }

  get channelId() {
    return this.raw.channel_id ?? this.raw.channel?.id;
  }

  get user() {
    return this.raw.member?.user ?? this.raw.user;
  }

  get userId() {
    return this.user?.id;
  }

  get displayName() {
    return this.raw.member?.nick ?? this.user?.global_name ?? this.user?.username;
  }

  get avatar() {
    return avatarUrl(this.user);
  }

  get customId() {
    return this.raw.data?.custom_id ?? '';
  }

  get values() {
    return this.raw.data?.values ?? [];
  }

  get commandName() {
    return this.raw.data?.name;
  }

  get isComponent() {
    return this.type === InteractionType.MESSAGE_COMPONENT;
  }

  get isModalSubmit() {
    return this.type === InteractionType.MODAL_SUBMIT;
  }

  /** メニューのメッセージから開かれたか（＝そのメッセージを書き換えられるか）。 */
  get fromMessage() {
    return Boolean(this.raw.message);
  }

  /** 「サーバー管理」または「管理者」権限を持っているか。 */
  get isAdmin() {
    const permissions = this.raw.member?.permissions;
    if (!permissions) return false;
    try {
      return (BigInt(permissions) & ADMIN_PERMISSIONS) !== 0n;
    } catch {
      return false;
    }
  }

  /** 入力フォームの値を取り出す。 */
  field(customId) {
    return formComponent(this.raw, customId)?.value ?? '';
  }

  /** フォームの中の選択リストで選ばれたもの（選ばれていなければ空）。 */
  fieldValues(customId) {
    return formComponent(this.raw, customId)?.values ?? [];
  }

  /** フォームの中のメンバー選択で選ばれた人の情報。 */
  fieldUser(customId) {
    const component = formComponent(this.raw, customId);
    const userId = component?.values?.[0];
    if (!userId) return null;
    const resolved = component.resolved?.users ?? this.raw.data?.resolved?.users ?? {};
    return { id: userId, ...(resolved[userId] ?? {}) };
  }

  /** 右クリック（長押し）メニューで選ばれた相手。 */
  get targetId() {
    return this.raw.data?.target_id ?? null;
  }

  get targetUser() {
    const id = this.targetId;
    return id ? (this.raw.data?.resolved?.users?.[id] ?? { id }) : null;
  }
}
