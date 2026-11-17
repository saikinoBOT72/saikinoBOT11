import { wrapD1 } from './lib/sql.js';
import { createRest } from './discord/rest.js';
import { getSettings } from './lib/economy.js';
import { clampHour } from './lib/calendar.js';
import { loadEmoji } from './lib/emoji.js';
import { errorNotice, recordError } from './lib/error-report.js';

/**
 * 1リクエストぶんの道具箱。DB・Discord API・サーバー設定をまとめて持ち回る。
 */
export function createContext(env, executionCtx) {
  const db = wrapD1(env.DB);
  const rest = createRest(env.DISCORD_TOKEN);
  const settingsCache = new Map();
  let emojiCache = null;

  return {
    db,
    env,
    rest,
    timezone: env.TIMEZONE ?? 'Asia/Tokyo',

    /**
     * 「1日」の数え方。DAY_START_HOUR に 4 を入れると 4:00〜翌3:59 が同じ日になる。
     * 連続記録・1日の回数制限・今日/今週の集計は、すべてこの区切りで数える。
     */
    calendar: {
      timezone: env.TIMEZONE ?? 'Asia/Tokyo',
      dayStartHour: clampHour(env.DAY_START_HOUR ?? 0),
    },

    async settings(guildId) {
      if (!settingsCache.has(guildId)) settingsCache.set(guildId, await getSettings(db, guildId));
      return settingsCache.get(guildId);
    },

    forgetSettings(guildId) {
      settingsCache.delete(guildId);
    },

    /**
     * 画面で使う絵文字。取り込み済みのカスタム絵文字があればそれ、無ければ既定。
     * アプリ全体で1組なのでサーバーごとの区別はない。
     */
    async emoji() {
      if (!emojiCache) emojiCache = await loadEmoji(db);
      return emojiCache;
    },

    forgetEmoji() {
      emojiCache = null;
    },

    /** いま応えている操作（押した人にあとから一言送るのに使う）。index.js が入れる。 */
    ix: null,

    /** 応答を返したあとで走らせる処理（チャンネルへの告知など）。 */
    waitUntil(promise) {
      if (executionCtx?.waitUntil) executionCtx.waitUntil(promise.catch((error) => console.error(error)));
      else promise.catch((error) => console.error(error));
    },

    /**
     * エラーを記録し、管理用チャンネルが決まっていれば知らせる（同じものは間をあけて）。
     * ここで失敗しても本来の処理は止めない。
     */
    async reportError(guildId, place, error) {
      console.error(`${place} で失敗:`, error);
      try {
        const channelId = await recordError(db, guildId, place, error);
        if (channelId) await rest.createMessage(channelId, errorNotice(place, error));
      } catch (inner) {
        console.error('エラーの記録に失敗:', inner);
      }
    },

    /**
     * みんなに見えるメッセージをチャンネルに流す。
     * 投稿できなかったら（Bot がそのチャンネルに書けない等）、押した本人にだけそう伝え、
     * 管理用チャンネルにも記録する。黙って消えないように。
     */
    announce(channelId, payload) {
      if (!channelId) return;
      const ix = this.ix;
      this.waitUntil(
        rest.createMessage(channelId, payload).catch(async (error) => {
          await this.reportError(ix?.guildId, 'チャンネルへの投稿', error);
          if (ix?.raw?.application_id && ix.raw.token) {
            await rest
              .createFollowup(ix.raw.application_id, ix.raw.token, {
                content:
                  `⚠️ <#${channelId}> に投稿できませんでした。操作そのものは済んでいます。\n` +
                  'Bot がそのチャンネルを見られるか・書き込めるかを、サーバー管理者に確かめてもらってください。',
              })
              .catch((followupError) => console.error('お知らせの送信に失敗:', followupError));
          }
        }),
      );
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
