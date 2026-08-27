export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
};

export const CallbackType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
};

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5,
  CHANNEL_SELECT: 8,
};

export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };

export const TextInputStyle = { SHORT: 1, PARAGRAPH: 2 };

export const MessageFlags = { EPHEMERAL: 64 };

/** サーバー管理 or 管理者 */
export const ADMIN_PERMISSIONS = (1n << 5n) | (1n << 3n);

/** コマンドを使える場所（0=サーバー内 1=BotとのDM 2=その他のDM）。 */
export const InteractionContextType = { GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 };

export const DISCORD_API = 'https://discord.com/api/v10';
