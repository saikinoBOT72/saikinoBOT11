import { DISCORD_API } from './constants.js';

/** Discord REST API の最小限のクライアント。 */
export function createRest(token) {
  async function call(method, path, body) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API ${method} ${path} が失敗しました (${response.status}): ${text}`);
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    /** チャンネルに投稿する（みんなに見える告知用）。 */
    createMessage(channelId, payload) {
      return call('POST', `/channels/${channelId}/messages`, payload);
    },
    editMessage(channelId, messageId, payload) {
      return call('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
    },
    /**
     * 返事として出したメッセージを後から書き換える。
     * 「回転中…」→「結果」のような演出に使う（トークンは15分間有効）。
     */
    editOriginalResponse(applicationId, interactionToken, payload) {
      return call('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, payload);
    },

    /** スラッシュコマンドの登録。 */
    putCommands(applicationId, guildId, commands) {
      const path = guildId
        ? `/applications/${applicationId}/guilds/${guildId}/commands`
        : `/applications/${applicationId}/commands`;
      return call('PUT', path, commands);
    },
  };
}
