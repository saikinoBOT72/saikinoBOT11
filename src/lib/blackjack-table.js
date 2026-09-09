/**
 * ブラックジャックの卓の出し入れ。
 *
 * duels と同じく、読んだときの version のままでなければ書けないようにして、
 * 同時押しでも手札や手番がすり替わらないようにする。
 */
import { deposit, withdraw } from './economy.js';
import { MAX_PLAYERS, dealerShouldHit, isBlackjack, outcome, payout } from './blackjack.js';
import { draw, newDeck } from './cards.js';

/** 参加を待つ時間と、席についてからの持ち時間。 */
export const JOIN_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 300_000;

export async function createTable(db, { id, guildId, channelId, hostId, bet }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO blackjack_tables (id, guild_id, channel_id, host_id, bet, status, state, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'joining', ?6, ?7, ?8)`,
    id,
    guildId,
    channelId,
    hostId,
    bet,
    JSON.stringify({ players: [], dealer: [], deck: [], turn: 0 }),
    now + JOIN_TIMEOUT_MS,
    now,
  );
  return getTable(db, id);
}

export async function getTable(db, id) {
  return db.get('SELECT * FROM blackjack_tables WHERE id = ?1', id);
}

export function stateOf(table) {
  try {
    return JSON.parse(table.state);
  } catch {
    return { players: [], dealer: [], deck: [], turn: 0 };
  }
}

export async function setMessageId(db, id, messageId) {
  await db.run('UPDATE blackjack_tables SET message_id = ?2 WHERE id = ?1', id, messageId);
}

export async function setStatus(db, id, status) {
  await db.run('UPDATE blackjack_tables SET status = ?2 WHERE id = ?1', id, status);
}

/**
 * 状態を安全に書き換える。
 * 書けなかったら読み直してやり直す（duel.mutate と同じ考え方）。
 * @returns {Promise<{ok: true, table: object, state: object, extra?: any} | {ok: false, reason: string}>}
 */
export async function mutate(db, id, apply, { allow = ['joining', 'playing'], attempts = 6 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const table = await getTable(db, id);
    if (!table) return { ok: false, reason: 'missing' };
    if (!allow.includes(table.status)) return { ok: false, reason: 'closed' };

    const result = apply({ table, state: stateOf(table) });
    if (result?.reject) return { ok: false, reason: result.reject };

    const written = await db.run(
      `UPDATE blackjack_tables SET state = ?3, status = ?4, version = version + 1, expires_at = ?5
        WHERE id = ?1 AND version = ?2`,
      id,
      table.version,
      JSON.stringify(result.state),
      result.status ?? table.status,
      Date.now() + (result.status === 'playing' || table.status === 'playing' ? PLAY_TIMEOUT_MS : JOIN_TIMEOUT_MS),
    );
    if (written.changes === 1) {
      return { ok: true, table: await getTable(db, id), state: result.state, extra: result.extra };
    }
  }
  return { ok: false, reason: 'busy' };
}

/* ------------------------------------------------------------------ 席につく */

export function seatOf(state, userId) {
  return state.players.findIndex((player) => player.userId === userId);
}

/**
 * 席につく。先に席を取ってから引き落とし、払えなければ席を返す。
 * @returns {Promise<{ok: true, state: object} | {ok: false, reason: string}>}
 */
export async function joinTable(db, table, userId) {
  const claimed = await mutate(
    db,
    table.id,
    ({ state }) => {
      if (seatOf(state, userId) >= 0) return { reject: 'already' };
      if (state.players.length >= MAX_PLAYERS) return { reject: 'full' };
      return {
        state: {
          ...state,
          players: [...state.players, { userId, bet: table.bet, cards: [], status: 'playing', doubled: false }],
        },
      };
    },
    { allow: ['joining'] },
  );
  if (!claimed.ok) return claimed;

  if (!(await withdraw(db, table.guild_id, userId, table.bet, 'blackjack:bet', table.id))) {
    await mutate(
      db,
      table.id,
      ({ state }) => ({ state: { ...state, players: state.players.filter((p) => p.userId !== userId) } }),
      { allow: ['joining'] },
    );
    return { ok: false, reason: 'insufficient' };
  }
  return claimed;
}

/* ------------------------------------------------------------------ 配る・進める */

/** 山札を作って、全員とディーラーに2枚ずつ配る。 */
export function deal(state) {
  const deck = newDeck();
  const players = state.players.map((player) => ({ ...player, cards: [draw(deck), draw(deck)] }));
  const dealer = [draw(deck), draw(deck)];

  // 最初の2枚で21ならその場で確定（もう引けない）
  for (const player of players) {
    if (isBlackjack(player.cards)) player.status = 'blackjack';
  }
  return { ...state, deck, players, dealer, turn: nextActive(players, -1) };
}

/** 次に手番が回る人の席番号。もういなければ -1。 */
export function nextActive(players, from) {
  for (let index = from + 1; index < players.length; index++) {
    if (players[index].status === 'playing') return index;
  }
  return -1;
}

/** ディーラーが規定どおり引く。 */
export function playDealer(state) {
  const deck = [...state.deck];
  const dealer = [...state.dealer];
  // 全員バーストしているなら、ディーラーは引かなくてよい
  const someoneAlive = state.players.some((player) => player.status !== 'bust');
  if (someoneAlive) {
    while (dealerShouldHit(dealer)) dealer.push(draw(deck));
  }
  return { ...state, deck, dealer };
}

/**
 * 精算する。取れた1つだけが配る。
 * @returns {Promise<null | Array<{userId, stake, kind, label, amount}>>}
 */
export async function settleTable(db, table, state) {
  const claimed = await db.run(
    "UPDATE blackjack_tables SET status = 'done', state = ?3, version = version + 1 WHERE id = ?1 AND version = ?2 AND status = 'playing'",
    table.id,
    table.version,
    JSON.stringify(state),
  );
  if (claimed.changes !== 1) return null;

  const results = [];
  for (const player of state.players) {
    const stake = player.bet * (player.doubled ? 2 : 1);
    const result = outcome(player.cards, state.dealer);
    const amount = payout(stake, result.multiplier);
    if (amount > 0) {
      await deposit(db, table.guild_id, player.userId, amount, 'blackjack:win', table.id);
    }
    results.push({ userId: player.userId, stake, kind: result.kind, label: result.label, amount });
  }
  return results;
}

/** 賭け金を全員に返す。 */
export async function refundTable(db, table, state) {
  for (const player of state.players) {
    const stake = player.bet * (player.doubled ? 2 : 1);
    if (stake > 0) await deposit(db, table.guild_id, player.userId, stake, 'blackjack:refund', table.id);
  }
}

/** 時間切れの卓（1分ごとの定期処理から拾う）。 */
export async function expiredTables(db, now = Date.now()) {
  return db.all(
    "SELECT * FROM blackjack_tables WHERE status IN ('joining', 'playing') AND expires_at <= ?1 LIMIT 25",
    now,
  );
}
