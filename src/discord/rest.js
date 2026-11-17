import { DISCORD_API } from './constants.js';

/**
 * 通知を飛ばしてよい相手の既定。
 * 何も指定しないと、本文に @everyone やロールが入っていれば全員に通知が飛ぶ。
 * みんなが書いた文字（商品名・お題・メモ）が本文に入ることがあるので、
 * 指定が無ければ「本文に書いた人にだけ」に絞る。
 */
export const SAFE_MENTIONS = { parse: ['users'] };

/** メッセージの中身に、通知の既定を入れる。 */
export function withSafeMentions(payload) {
  if (!payload || typeof payload !== 'object' || 'allowed_mentions' in payload) return payload;
  return { ...payload, allowed_mentions: SAFE_MENTIONS };
}

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
      return call('POST', `/channels/${channelId}/messages`, withSafeMentions(payload));
    },
    editMessage(channelId, messageId, payload) {
      return call('PATCH', `/channels/${channelId}/messages/${messageId}`, withSafeMentions(payload));
    },
    /**
     * 返事として出したメッセージを後から書き換える。
     * 「回転中…」→「結果」のような演出に使う（トークンは15分間有効）。
     */
    editOriginalResponse(applicationId, interactionToken, payload) {
      return call('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, withSafeMentions(payload));
    },

    /**
     * このアプリ自身が持っている絵文字（アプリケーション絵文字）の一覧。
     * サーバーに属さないので、Bot はどこでもこれを使える。
     */
    async listApplicationEmojis(applicationId) {
      const result = await call('GET', `/applications/${applicationId}/emojis`);
      // 返り値は { items: [...] } の形だが、配列で返る場合にも備えておく
      return Array.isArray(result) ? result : (result?.items ?? []);
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
