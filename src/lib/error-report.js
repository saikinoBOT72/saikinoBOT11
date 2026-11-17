/**
 * エラーを記録して、管理用チャンネルに知らせる。
 *
 * 【何を残すか】
 * どこで起きたか（画面や定期処理の名前）と、短くしたエラーの説明だけ。
 * 入力された文字・メッセージの本文・トークンは入れない。
 * Discord の ID のような長い数字は伏せる（別のサーバーの ID が混ざっても見えないように）。
 *
 * 【うるさくしない】
 * 同じエラーは1行にまとめて回数だけ数え、管理用チャンネルへは同じものを
 * NOTIFY_INTERVAL_MS に1回までしか知らせない。
 */
import { embed } from '../discord/builders.js';

export const NOTIFY_INTERVAL_MS = 30 * 60 * 1000;

/** エラーの説明を、残してよい形にする。 */
export function describeError(error) {
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : '';
  return `${name}${String(error?.message ?? error ?? '不明なエラー')}`
    .replace(/Bot\s+[\w.-]{20,}/g, 'Bot <token>')
    .replace(/\d{15,}/g, '<id>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/** 同じエラーかどうかの目印。数字や ID が違うだけなら同じものとして数える。 */
function fingerprintOf(place, message) {
  return `${place}|${message.replace(/\d+/g, '#')}`.slice(0, 200);
}

/**
 * エラーを記録する。知らせるべきなら、その guild の管理用チャンネルを返す。
 * @returns {Promise<string|null>} 知らせる先のチャンネル（知らせなくてよければ null）
 */
export async function recordError(db, guildId, place, error, now = Date.now()) {
  if (!guildId) return null;
  const message = describeError(error);
  const fingerprint = fingerprintOf(place, message);
  await db.run(
    `INSERT INTO error_reports (guild_id, fingerprint, place, message, count, first_at, last_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
     ON CONFLICT(guild_id, fingerprint) DO UPDATE SET count = count + 1, last_at = ?5, message = ?4`,
    guildId,
    fingerprint,
    place,
    message,
    now,
  );

  const settings = await db.get('SELECT log_channel_id FROM guild_settings WHERE guild_id = ?1', guildId);
  if (!settings?.log_channel_id) return null;

  // 前に知らせてから時間が経っていれば、知らせる権利を取る（同時に起きても1回だけ）
  const claimed = await db.run(
    `UPDATE error_reports SET notified_at = ?3
      WHERE guild_id = ?1 AND fingerprint = ?2 AND (notified_at IS NULL OR notified_at <= ?4)`,
    guildId,
    fingerprint,
    now,
    now - NOTIFY_INTERVAL_MS,
  );
  return claimed.changes === 1 ? settings.log_channel_id : null;
}

/** 管理用チャンネルに出すお知らせ。 */
export function errorNotice(place, error, count = 1) {
  return {
    embeds: [
      embed({
        color: 0xe74c3c,
        title: '⚠️ Bot でエラーが起きました',
        description: `**場所** ${place}\n**内容** ${describeError(error)}`,
        footer: {
          text:
            (count > 1 ? `同じエラーが ${count} 回起きています・` : '') +
            `同じものは${NOTIFY_INTERVAL_MS / 60000}分に1回だけ知らせます・⚙️ 管理 → 管理用チャンネル で一覧を見られます`,
        },
      }),
    ],
    allowed_mentions: { parse: [] },
  };
}

/** 直近のエラー（管理画面に出す）。 */
export async function recentErrors(db, guildId, limit = 10) {
  return db.all('SELECT * FROM error_reports WHERE guild_id = ?1 ORDER BY last_at DESC LIMIT ?2', guildId, limit);
}

export async function clearErrors(db, guildId) {
  await db.run('DELETE FROM error_reports WHERE guild_id = ?1', guildId);
}
