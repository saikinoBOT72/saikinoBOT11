import { ADMIN_PERMISSIONS, InteractionType } from './constants.js';
import { avatarUrl } from './builders.js';

/** Discord から届いた JSON を扱いやすくする薄い包み。 */
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
    for (const row of this.raw.data?.components ?? []) {
      for (const component of row.components ?? []) {
        if (component.custom_id === customId) return component.value ?? '';
      }
    }
    return '';
  }
}
