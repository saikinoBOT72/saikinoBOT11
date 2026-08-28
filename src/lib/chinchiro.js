import { deposit } from './economy.js';
import { MAX_MULTIPLIER } from './dice.js';

export const INVITE_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 300_000;

/** 動く可能性のある最大額。これを先に預かるので「払えない」が起きない。 */
export function escrowFor(bet) {
  return bet * MAX_MULTIPLIER;
}

export async function createMatch(db, { id, guildId, channelId, challengerId, opponentId, bet }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO chinchiro_matches
       (id, guild_id, channel_id, challenger_id, opponent_id, bet, escrow, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)`,
    id,
    guildId,
    channelId,
    challengerId,
    opponentId,
    bet,
    escrowFor(bet),
    now + INVITE_TIMEOUT_MS,
    now,
  );
  return getMatch(db, id);
}

export async function getMatch(db, id) {
  return db.get('SELECT * FROM chinchiro_matches WHERE id = ?1', id);
}

export async function setMessageId(db, id, messageId) {
  await db.run('UPDATE chinchiro_matches SET message_id = ?2 WHERE id = ?1', id, messageId);
}

export async function setStatus(db, id, status) {
  await db.run('UPDATE chinchiro_matches SET status = ?2 WHERE id = ?1', id, status);
}

/** pending → playing。先に取れた1つだけが成功する。 */
export async function markPlaying(db, id) {
  const result = await db.run(
    "UPDATE chinchiro_matches SET status = 'playing', turn = 'challenger', expires_at = ?2 WHERE id = ?1 AND status = 'pending'",
    id,
    Date.now() + PLAY_TIMEOUT_MS,
  );
  return result.changes === 1;
}

/**
 * 出目を記録して手番を渡す。すでに振っていたら false。
 * 同時押しでも二重に振れないよう、手番を条件に入れて取り合う。
 */
export async function recordRoll(db, id, role, throws) {
  const column = role === 'challenger' ? 'challenger_dice' : 'opponent_dice';
  const nextTurn = role === 'challenger' ? 'opponent' : null;
  const result = await db.run(
    `UPDATE chinchiro_matches SET ${column} = ?2, turn = ?3, expires_at = ?4
      WHERE id = ?1 AND status = 'playing' AND turn = ?5 AND ${column} IS NULL`,
    id,
    JSON.stringify(throws),
    nextTurn,
    Date.now() + PLAY_TIMEOUT_MS,
    role,
  );
  return result.changes === 1;
}

/** 決着を確定する。取れた1つだけが精算する。 */
export async function finishMatch(db, id) {
  const result = await db.run("UPDATE chinchiro_matches SET status = 'done' WHERE id = ?1 AND status = 'playing'", id);
  return result.changes === 1;
}

/** 預かった額を両者に返す。 */
export async function refundEscrow(db, match, reason = 'chinchiro:refund') {
  if (match.escrow <= 0) return;
  await deposit(db, match.guild_id, match.challenger_id, match.escrow, reason, `cc:${match.id}`);
  await deposit(db, match.guild_id, match.opponent_id, match.escrow, reason, `cc:${match.id}`);
}

/**
 * 精算する。預かった額から勝敗ぶんを移し、余りを返す。
 * @param {'challenger'|'opponent'|'draw'} winner
 */
export async function settle(db, match, winner, multiplier) {
  const prize = multiplier * match.bet;
  if (winner === 'draw') {
    await refundEscrow(db, match);
    return { prize: 0 };
  }
  const winnerId = winner === 'challenger' ? match.challenger_id : match.opponent_id;
  const loserId = winner === 'challenger' ? match.opponent_id : match.challenger_id;

  await deposit(db, match.guild_id, winnerId, match.escrow + prize, 'chinchiro:win', `cc:${match.id}`);
  if (match.escrow - prize > 0) {
    await deposit(db, match.guild_id, loserId, match.escrow - prize, 'chinchiro:refund', `cc:${match.id}`);
  }
  return { prize, winnerId, loserId };
}

export async function cancelExpired(db, now = Date.now()) {
  const matches = await db.all(
    "SELECT * FROM chinchiro_matches WHERE status IN ('pending', 'playing') AND expires_at <= ?1 LIMIT 25",
    now,
  );
  const handled = [];
  for (const match of matches) {
    const claimed = await db.run(
      "UPDATE chinchiro_matches SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')",
      match.id,
    );
    if (claimed.changes !== 1) continue;
    const refunded = match.status === 'playing' && match.escrow > 0;
    if (refunded) await refundEscrow(db, match);
    handled.push({ match, refunded });
  }
  return handled;
}
