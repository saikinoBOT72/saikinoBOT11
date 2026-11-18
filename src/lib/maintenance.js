/**
 * データベースの片付け（1日1回、定期処理から）。
 *
 * Cloudflare D1 の無料枠は「読んだ行」「書いた行」「保存量」で決まる。
 * 遊ぶほど増え続けるものを、意味を変えずに小さくしておく。
 *
 * 【コインの履歴】180日より前の行は「人・理由・月・増えたか減ったか」ごとに1行へまとめる。
 *   合計は変わらないので、残高と履歴の合計は一致したまま（累計獲得・累計使用も同じ）。
 *   まとめた件数は entries に残すので、「ゲームで遊んだ回数」の称号なども数え違えない。
 * 【終わった勝負・卓】30日より前に終わったものは消す（勝ち負けは match_results に残っている）。
 * 【エラーの記録】30日より前に最後に起きたものは消す。
 */
import { dateKey } from './calendar.js';

export const LEDGER_KEEP_DAYS = 180;
export const FINISHED_KEEP_DAYS = 30;
const DAY = 24 * 3600 * 1000;

/** 今日まだやっていなければ true（印を付ける）。同じ日に何度呼ばれても1回だけ。 */
export async function claimDaily(db, key, calendar, now = Date.now()) {
  const today = dateKey(calendar, new Date(now));
  const result = await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE app_state.value != excluded.value`,
    key,
    today,
    now,
  );
  return result.changes === 1;
}

/**
 * 古い履歴をまとめる。まとめる行の選び方（古い・まだまとめていない）は2つの文で同じにし、
 * 同じ処理（トランザクション）の中で「まとめた行を足す → 元の行を消す」をする。
 * @returns {Promise<number>} 消した（まとめた）行の数
 */
export async function compactLedger(db, now = Date.now()) {
  const cut = now - LEDGER_KEEP_DAYS * DAY;
  const results = await db.batch([
    [
      `INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at, entries, compacted)
       SELECT guild_id, user_id, SUM(amount), reason,
              strftime('%Y-%m', created_at / 1000, 'unixepoch') || ' のまとめ（' || SUM(entries) || '件）',
              MAX(created_at), SUM(entries), 1
         FROM ledger
        WHERE created_at < ?1 AND compacted = 0
        GROUP BY guild_id, user_id, reason, amount < 0, strftime('%Y-%m', created_at / 1000, 'unixepoch')`,
      cut,
    ],
    ['DELETE FROM ledger WHERE created_at < ?1 AND compacted = 0', cut],
  ]);
  return results[1].changes ?? 0;
}

/** 終わってから時間がたった勝負・卓・エラーの記録を消す。 */
export async function pruneFinished(db, now = Date.now()) {
  const cut = now - FINISHED_KEEP_DAYS * DAY;
  const finished = "status IN ('done', 'cancelled') AND created_at < ?1";
  await db.batch([
    ...['rps_matches', 'chinchiro_matches', 'duels', 'blackjack_tables', 'poker_tables', 'pig_tables', 'chohan_tables', 'yacht_tables'].map(
      (table) => [`DELETE FROM ${table} WHERE ${finished}`, cut],
    ),
    ['DELETE FROM error_reports WHERE last_at < ?1', cut],
  ]);
}
