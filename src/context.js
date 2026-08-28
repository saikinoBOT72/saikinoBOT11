import { wrapD1 } from './lib/sql.js';
import { createRest } from './discord/rest.js';
import { getSettings } from './lib/economy.js';

/**
 * 1リクエストぶんの道具箱。DB・Discord API・サーバー設定をまとめて持ち回る。
 */
export function createContext(env, executionCtx) {
  const db = wrapD1(env.DB);
  const rest = createRest(env.DISCORD_TOKEN);
  const settingsCache = new Map();

  return {
    db,
    env,
    rest,
    timezone: env.TIMEZONE ?? 'Asia/Tokyo',

    async settings(guildId) {
      if (!settingsCache.has(guildId)) settingsCache.set(guildId, await getSettings(db, guildId));
      return settingsCache.get(guildId);
    },

    forgetSettings(guildId) {
      settingsCache.delete(guildId);
    },

    /** 応答を返したあとで走らせる処理（チャンネルへの告知など）。 */
    waitUntil(promise) {
      if (executionCtx?.waitUntil) executionCtx.waitUntil(promise.catch((error) => console.error(error)));
      else promise.catch((error) => console.error(error));
    },

    /** みんなに見えるメッセージをチャンネルに流す。 */
    announce(channelId, payload) {
      if (!channelId) return;
      this.waitUntil(rest.createMessage(channelId, payload));
    },

    /**
     * 返事を出したあと、少し間を置いて画面を書き換えていく（スロットの回転など）。
     * @param {import('./discord/interaction.js').Ix} ix
     * @param {Array<{after: number, payload: object}>} steps 前の段階からの待ち時間(ms)と表示内容
     */
    animate(ix, steps) {
      const applicationId = ix.raw.application_id;
      const token = ix.raw.token;
      if (!applicationId || !token) return;

      this.waitUntil(
        (async () => {
          for (const step of steps) {
            if (step.after > 0) await new Promise((resolve) => setTimeout(resolve, step.after));
            await rest.editOriginalResponse(applicationId, token, step.payload);
          }
        })(),
      );
    },
  };
}
