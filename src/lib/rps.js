import { deposit } from './economy.js';
import { EMOJI } from './emoji.js';
import { recordMatch } from './match-results.js';

export const HANDS = {
  rock: { emoji: EMOJI.hand_rock, label: 'グー' },
  scissors: { emoji: EMOJI.hand_scissors, label: 'チョキ' },
  paper: { emoji: EMOJI.hand_paper, label: 'パー' },
};

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export const INVITE_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 180_000;
export const MAX_DRAWS = 5;

/** @returns {'challenger'|'opponent'|'draw'} */
export function judge(challengerHand, opponentHand) {
  if (challengerHand === opponentHand) return 'draw';
  return BEATS[challengerHand] === opponentHand ? 'challenger' : 'opponent';
}

export async function createMatch(db, { id, guildId, channelId, challengerId, opponentId, bet }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO rps_matches (id, guild_id, channel_id, challenger_id, opponent_id, bet, status, round, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 1, ?7, ?8)`,
    id,
    guildId,
    channelId,
    challengerId,
    opponentId,
    bet,
    now + INVITE_TIMEOUT_MS,
    now,
  );
  return getMatch(db, id);
}

export async function getMatch(db, id) {
  return db.get('SELECT * FROM rps_matches WHERE id = ?1', id);
}

export async function setMessageId(db, id, messageId) {
  await db.run('UPDATE rps_matches SET message_id = ?2 WHERE id = ?1', id, messageId);
}

/** pending → playing。すでに誰かが開始していたら false。 */
export async function markPlaying(db, id) {
  const result = await db.run(
    "UPDATE rps_matches SET status = 'playing', expires_at = ?2 WHERE id = ?1 AND status = 'pending'",
    id,
    Date.now() + PLAY_TIMEOUT_MS,
  );
  return result.changes === 1;
}

export async function setStatus(db, id, status) {
  await db.run('UPDATE rps_matches SET status = ?2 WHERE id = ?1', id, status);
}

/** 手を登録する。すでに出していたら false。 */
export async function setHand(db, id, role, hand) {
  const column = role === 'challenger' ? 'challenger_hand' : 'opponent_hand';
  const result = await db.run(
    `UPDATE rps_matches SET ${column} = ?2 WHERE id = ?1 AND status = 'playing' AND ${column} IS NULL`,
    id,
    hand,
  );
  return result.changes === 1;
}

/**
 * 決着を確定する。
 * 二人が同時にボタンを押すと両方のリクエストが「手が揃った」と判断しうるため、
 * この1文を取れた側だけが賞金を払う（そうしないと二重に支払われる）。
 * @returns {Promise<boolean>} 自分が確定した側なら true
 */
export async function finishMatch(db, id) {
  const result = await db.run("UPDATE rps_matches SET status = 'done' WHERE id = ?1 AND status = 'playing'", id);
  return result.changes === 1;
}

/**
 * あいこ。手をリセットして次のラウンドへ。
 * これも同時押しで二重に進まないよう、いまのラウンド番号を条件に入れて取り合う。
 * @returns {Promise<object|null>} 進めた側だけ新しい対戦内容が返る
 */
export async function nextRound(db, id, currentRound) {
  const result = await db.run(
    `UPDATE rps_matches
        SET challenger_hand = NULL, opponent_hand = NULL, round = round + 1, expires_at = ?3
      WHERE id = ?1 AND round = ?2 AND status = 'playing'
        AND challenger_hand IS NOT NULL AND opponent_hand IS NOT NULL`,
    id,
    currentRound,
    Date.now() + PLAY_TIMEOUT_MS,
  );
  return result.changes === 1 ? getMatch(db, id) : null;
}

/** 預かった賭け金を両者に返す。 */
export async function refund(db, match, reason = 'rps:refund') {
  if (match.bet <= 0) return;
  await deposit(db, match.guild_id, match.challenger_id, match.bet, reason, `rps:${match.id}`);
  await deposit(db, match.guild_id, match.opponent_id, match.bet, reason, `rps:${match.id}`);
}

/** 期限切れの対戦を拾う（1分ごとの定期実行から呼ぶ）。 */
export async function expiredMatches(db, now = Date.now()) {
  return db.all("SELECT * FROM rps_matches WHERE status IN ('pending', 'playing') AND expires_at <= ?1 LIMIT 25", now);
}

/**
 * 期限切れの対戦を片付ける。
 *
 * 片方だけ手を出していたら、出さなかった人の負け（負けそうだから放置、を許さない）。
 * 二人とも出していなければ返金。状態を先に書き換え、取れた1つだけが払う。
 * @returns {Promise<Array<{match: object, refunded: boolean, winnerId?: string, loserId?: string}>>}
 */
export async function cancelExpired(db, now = Date.now()) {
  const matches = await expiredMatches(db, now);
  const handled = [];
  for (const match of matches) {
    const challengerOnly = Boolean(match.challenger_hand) && !match.opponent_hand;
    const opponentOnly = Boolean(match.opponent_hand) && !match.challenger_hand;
    const forfeit = match.status === 'playing' && match.bet > 0 && (challengerOnly || opponentOnly);

    // 読んだときのまま（手もラウンドも変わっていない）ときだけ書き換える
    const claimed = await db.run(
      `UPDATE rps_matches SET status = ?2
        WHERE id = ?1 AND status = ?3 AND round = ?4
          AND challenger_hand IS ?5 AND opponent_hand IS ?6`,
      match.id,
      forfeit ? 'done' : 'cancelled',
      match.status,
      match.round,
      match.challenger_hand,
      match.opponent_hand,
    );
    if (claimed.changes !== 1) continue;

    if (forfeit) {
      const winnerId = challengerOnly ? match.challenger_id : match.opponent_id;
      const loserId = challengerOnly ? match.opponent_id : match.challenger_id;
      await deposit(db, match.guild_id, winnerId, match.bet * 2, 'rps:win', match.id);
      await recordMatch(db, { guildId: match.guild_id, game: 'rps', winnerId, loserId, amount: match.bet * 2 });
      handled.push({ match, refunded: false, winnerId, loserId });
      continue;
    }
    const refunded = match.status === 'playing' && match.bet > 0;
    if (refunded) await refund(db, match);
    handled.push({ match, refunded });
  }
  return handled;
}
