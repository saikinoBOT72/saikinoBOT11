/**
 * 時間切れの1分ほど前に、待たせている人にだけ知らせる。
 *
 * 時間切れは「動かなかった人の負け」なので、うっかり気づかないまま負けるのは気の毒。
 * 1分ごとの見回りで、締切が近い勝負を拾って、手番の人にメンションを送る。
 * 同じ締切には一度しか送らない（nudges に印を付ける）。誰かが動けば締切が延びるので、
 * 次の締切にはまた送れる。
 */

/** 締切まで、このあいだに入っていたら知らせる（見回りは1分ごとなので、幅は1分）。 */
export const NUDGE_FROM_MS = 30 * 1000;
export const NUDGE_TO_MS = 90 * 1000;

/** 締切が近い行を拾う。 */
export async function nearDeadline(db, table, now = Date.now()) {
  return db.all(
    `SELECT * FROM ${table} WHERE status = 'playing' AND expires_at > ?1 AND expires_at <= ?2 LIMIT 25`,
    now + NUDGE_FROM_MS,
    now + NUDGE_TO_MS,
  );
}

/** この締切にまだ知らせていなければ印を付ける（同時に動いても1回だけ true）。 */
export async function claimNudge(db, kind, targetId, deadline, now = Date.now()) {
  const claimed = await db.run(
    'INSERT OR IGNORE INTO nudges (kind, target_id, deadline, created_at) VALUES (?1, ?2, ?3, ?4)',
    kind,
    targetId,
    deadline,
    now,
  );
  return claimed.changes === 1;
}

/** 古い印を片付ける。 */
export async function sweepNudges(db, now = Date.now()) {
  await db.run('DELETE FROM nudges WHERE deadline < ?1', now - 60 * 60 * 1000);
}

/** 知らせる文。掲示への返信にして、どの勝負の話かが分かるようにする。 */
export function nudgePayload(userIds, messageId) {
  const unique = [...new Set(userIds.filter(Boolean))];
  return {
    content:
      `⏰ ${unique.map((userId) => `<@${userId}>`).join(' ')} あと1分ほどで時間切れです。` +
      '動かないと負けになります。',
    allowed_mentions: { users: unique },
    message_reference: messageId ? { message_id: messageId, fail_if_not_exists: false } : undefined,
  };
}
