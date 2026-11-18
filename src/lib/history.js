/**
 * コインの履歴を、人が読みやすい形にまとめる。
 *
 * ・絞り込み：かせぐ／ゲーム／ショップ／送金・その他
 * ・まとめ：同じゲームの「賭け」と「払い戻し」が続いていたら1行にして収支を出す
 * ・日ごと：日付の見出しと、その日の合計
 */
import { dateKey } from './calendar.js';
import { reasonLabel } from './ledger-reasons.js';

const EARN = "reason IN ('report', 'report:undo', 'streak', 'achievement', 'ranking', 'initial')";
const SHOP = "reason LIKE 'shop:%'";
const GAME = "(reason LIKE '%:%' AND reason NOT LIKE 'shop:%' AND reason NOT LIKE 'admin:%' AND reason NOT LIKE 'tip:%' AND reason != 'report:undo')";

export const HISTORY_FILTERS = {
  all: { label: 'すべて', emoji: '📜', where: '1 = 1' },
  earn: { label: 'かせぐ', emoji: '💪', where: EARN },
  game: { label: 'ゲーム', emoji: '🎮', where: GAME },
  shop: { label: 'ショップ', emoji: '🛍️', where: SHOP },
  other: { label: '送金・その他', emoji: '💸', where: `NOT (${EARN}) AND NOT (${SHOP}) AND NOT ${GAME}` },
};

/** 1ページに読む履歴の行数（まとめる前）。 */
export const HISTORY_PAGE = 25;

/** 絞り込んだ履歴の1ページぶん。次のページがあるかも返す。 */
export async function historyPage(db, guildId, userId, filter = 'all', page = 0) {
  const where = (HISTORY_FILTERS[filter] ?? HISTORY_FILTERS.all).where;
  const rows = await db.all(
    `SELECT * FROM ledger WHERE guild_id = ?1 AND user_id = ?2 AND ${where} ORDER BY id DESC LIMIT ?3 OFFSET ?4`,
    guildId,
    userId,
    HISTORY_PAGE + 1,
    page * HISTORY_PAGE,
  );
  return { rows: rows.slice(0, HISTORY_PAGE), hasMore: rows.length > HISTORY_PAGE };
}

function gameOf(reason) {
  return String(reason ?? '').includes(':') ? reason.split(':')[0] : null;
}

/**
 * 続いている「賭け→払い戻し」を1つにまとめる（新しい順のまま）。
 * 同じゲームで、同じ勝負（detail が同じ）か同じ瞬間に書かれた行どうしをまとめる。
 */
export function groupEntries(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    const game = gameOf(row.reason);
    const sameGame = last && game && last.game === game;
    const sameRound = sameGame && ((row.detail && row.detail === last.detail) || row.created_at === last.created_at);
    if (sameRound && last.rows.length < 6) {
      last.rows.push(row);
      last.net += row.amount;
      continue;
    }
    groups.push({ game, detail: row.detail, created_at: row.created_at, rows: [row], net: row.amount });
  }
  return groups;
}

/** まとめた1行の文。 */
export function groupLine(group) {
  const signed = (n) => `${n >= 0 ? '+' : ''}${n.toLocaleString('ja-JP')}`;
  const time = `<t:${Math.floor(group.created_at / 1000)}:t>`;
  if (group.rows.length === 1) {
    const row = group.rows[0];
    // 古い履歴は月ごとにまとめてある（maintenance.js）。何件ぶんかを添える
    const label = row.compacted ? `${reasonLabel({ reason: row.reason })}（${row.detail}）` : reasonLabel(row);
    return `${time}　\`${signed(group.net)}\`　${label}`;
  }
  const parts = [...group.rows].reverse().map((row) => signed(row.amount)).join(' → ');
  const name = reasonLabel({ reason: group.game }) || group.game;
  return `${time}　\`${signed(group.net)}\`　${name}（${parts}）`;
}

/** 日付ごとに分けて、見出しとその日の合計を付ける。 */
export function byDay(groups, calendar) {
  const days = [];
  for (const group of groups) {
    const key = dateKey(calendar, new Date(group.created_at));
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, groups: [], net: 0 };
      days.push(day);
    }
    day.groups.push(group);
    day.net += group.net;
  }
  return days;
}
