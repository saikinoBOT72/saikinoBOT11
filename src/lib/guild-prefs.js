/**
 * 管理メニューの「Botの設定」で変えられるもの。
 * 値は guild_settings に入っている（0028_settings.sql）。
 */

/** 卓や挑戦状を出すチャンネル。決めていなければ押した場所。 */
export function gameChannelOf(settings, fallbackChannelId) {
  return settings?.game_channel_id || fallbackChannelId;
}

/** 実況を出すチャンネル。決めていなければ遊んだ場所。 */
export function liveChannelOf(settings, fallbackChannelId) {
  return settings?.live_channel_id || fallbackChannelId;
}

/** この勝ち負けを実況するか。基準が0なら実況しない。 */
export function shouldGoLive(settings, net) {
  const threshold = Number(settings?.live_threshold ?? 0);
  return threshold > 0 && Math.abs(net) >= threshold;
}

/**
 * 1人で遊ぶゲームの大きな勝ち負けを実況する。
 * 基準を決めていなければ何もしない。force（大当たりなど）は基準に関係なく出す。
 */
export function goLive(ctx, ix, settings, { net, embed, force = false }) {
  if (!force && !shouldGoLive(settings, net)) return;
  ctx.announce(liveChannelOf(settings, ix.channelId), { embeds: [embed], allowed_mentions: { parse: [] } });
}

/** 決着した掲示から、畳んだあとの1行を作る（見出しと、本文の最初の1行）。 */
export function summaryOf(payload, label) {
  const first = payload?.embeds?.[0] ?? {};
  const title = String(first.title ?? '').replace(/\s+/g, ' ').trim();
  const line = String(first.description ?? '').split('\n').find((text) => text.trim() !== '' && !text.startsWith('#')) ?? '';
  return [label, title, line.trim()].filter(Boolean).join('　').slice(0, 300);
}

/** 決着した掲示を、設定がオンなら5分後に1行へ畳む予約をする。row は guild_id / channel_id / message_id を持つ行。 */
export async function foldLater(ctx, row, payload, label) {
  if (!row?.message_id) return false;
  const settings = await ctx.settings(row.guild_id);
  return queueFold(ctx.db, settings, {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    summary: summaryOf(payload, label),
  });
}

/** 決着した掲示を畳むまでの時間。結果を読む時間を残す。 */
export const FOLD_AFTER_MS = 5 * 60 * 1000;

/**
 * 決着した掲示を、あとで結果の1行に畳む予約をする（設定がオンのときだけ）。
 * summary はその1行。中身はメンションと短い結果だけにすること。
 */
export async function queueFold(db, settings, { guildId, channelId, messageId, summary }, now = Date.now()) {
  if (!settings?.fold_finished || !channelId || !messageId || !summary) return false;
  await db.run(
    `INSERT OR REPLACE INTO fold_queue (message_id, channel_id, guild_id, summary, fold_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
    messageId,
    channelId,
    guildId,
    summary.slice(0, 300),
    now + FOLD_AFTER_MS,
  );
  return true;
}

/** 畳む時間が来たもの。取り出したら消す（二度畳まない）。 */
export async function takeDueFolds(db, now = Date.now()) {
  const rows = await db.all('SELECT * FROM fold_queue WHERE fold_at <= ?1 ORDER BY fold_at LIMIT 25', now);
  const taken = [];
  for (const row of rows) {
    const removed = await db.run('DELETE FROM fold_queue WHERE message_id = ?1', row.message_id);
    if (removed.changes === 1) taken.push(row);
  }
  return taken;
}
