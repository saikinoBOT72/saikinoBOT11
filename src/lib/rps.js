import { getDb } from './db.js';
import { deposit } from './economy.js';

export const HANDS = {
  rock: { emoji: '✊', label: 'グー' },
  scissors: { emoji: '✌️', label: 'チョキ' },
  paper: { emoji: '🖐️', label: 'パー' },
};

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

/** 'challenger' | 'opponent' | 'draw' */
export function judge(challengerHand, opponentHand) {
  if (challengerHand === opponentHand) return 'draw';
  return BEATS[challengerHand] === opponentHand ? 'challenger' : 'opponent';
}

export function createMatch({ id, guildId, channelId, challengerId, opponentId, bet }) {
  getDb()
    .prepare(
      `INSERT INTO rps_matches (id, guild_id, channel_id, challenger_id, opponent_id, bet, status, round, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)`,
    )
    .run(id, guildId, channelId, challengerId, opponentId, bet, Date.now());
  return getMatch(id);
}

export function getMatch(id) {
  return getDb().prepare('SELECT * FROM rps_matches WHERE id = ?').get(id);
}

export function setMessageId(id, messageId) {
  getDb().prepare('UPDATE rps_matches SET message_id = ? WHERE id = ?').run(messageId, id);
}

/** pending → playing。既に他の誰かが進めていたら false。 */
export function markPlaying(id) {
  return getDb().prepare("UPDATE rps_matches SET status = 'playing' WHERE id = ? AND status = 'pending'").run(id).changes === 1;
}

export function setStatus(id, status) {
  getDb().prepare('UPDATE rps_matches SET status = ? WHERE id = ?').run(status, id);
}

/** 手を登録する。既に選択済み／対戦中でない場合は false。 */
export function setHand(id, role, hand) {
  const column = role === 'challenger' ? 'challenger_hand' : 'opponent_hand';
  const res = getDb()
    .prepare(`UPDATE rps_matches SET ${column} = ? WHERE id = ? AND status = 'playing' AND ${column} IS NULL`)
    .run(hand, id);
  return res.changes === 1;
}

/** あいこ。手をリセットして次のラウンドへ。 */
export function nextRound(id) {
  getDb()
    .prepare("UPDATE rps_matches SET challenger_hand = NULL, opponent_hand = NULL, round = round + 1 WHERE id = ?")
    .run(id);
  return getMatch(id);
}

/** 賭け金を両者に返金する。 */
export function refund(match, reason) {
  if (match.bet <= 0) return;
  deposit(match.guild_id, match.challenger_id, match.bet, reason, `rps:${match.id}`);
  deposit(match.guild_id, match.opponent_id, match.bet, reason, `rps:${match.id}`);
}

/** 起動時、前回の停止で宙に浮いた対戦の賭け金を返金する。 */
export function refundStaleMatches() {
  const db = getDb();
  const stale = db.prepare("SELECT * FROM rps_matches WHERE status IN ('pending', 'playing')").all();
  for (const match of stale) {
    if (match.status === 'playing') refund(match, 'rps:refund');
    setStatus(match.id, 'cancelled');
  }
  return stale.length;
}
