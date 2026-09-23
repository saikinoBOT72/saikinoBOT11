/**
 * ピッグの卓。
 *
 * 【手番】
 * このゲームは順番に回す。いま誰の番かを state.turn（席の番号）で持ち、
 * 手番の人以外が押しても弾く。振るのも「やめる」のも一瞬で終わるので、
 * 待ち時間はほとんど出ない。
 *
 * 【お金】
 * 座った時点で参加費を預かる。全員ぶんがそのまま場になり、
 * 先に GOAL 点へ届いた人が総取り。時間切れなら全員に返す。
 */
import { deposit, withdraw } from './economy.js';
import { GOAL, applyRoll, rollDie } from './pig.js';
import { createTableStore } from './card-table.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export const JOIN_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 300_000;

const store = createTableStore('pig_tables', {
  emptyState: () => ({ players: [], turn: 0, turnTotal: 0, lastRoll: null, busted: false }),
  joinTimeoutMs: JOIN_TIMEOUT_MS,
  playTimeoutMs: PLAY_TIMEOUT_MS,
});

export const { createTable, getTable, stateOf, setMessageId, setStatus, mutate, expiredTables } = store;

export function seatOf(state, userId) {
  return state.players.findIndex((player) => player.userId === userId);
}

/** いま手番の人。 */
export function current(state) {
  return state.players[state.turn] ?? null;
}

export function isTurn(state, userId) {
  return current(state)?.userId === userId;
}

/** 席につく。先に席を取ってから引き落とし、払えなければ席を返す。 */
export async function joinTable(db, table, userId) {
  const claimed = await mutate(
    db,
    table.id,
    ({ state }) => {
      if (seatOf(state, userId) >= 0) return { reject: 'already' };
      if (state.players.length >= MAX_PLAYERS) return { reject: 'full' };
      return { state: { ...state, players: [...state.players, { userId, score: 0 }] } };
    },
    { allow: ['joining'] },
  );
  if (!claimed.ok) return claimed;

  if (!(await withdraw(db, table.guild_id, userId, table.bet, 'pig:ante', table.id))) {
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

/** 始める。最初の手番は卓を立てた人（席の先頭）。 */
export function start(state) {
  return { ...state, turn: 0, turnTotal: 0, lastRoll: null, busted: false };
}

/**
 * 1回振る。
 * 1が出たら貯金が消えて次の人へ。GOAL に届いたらその場で上がり。
 * @returns {{state: object, die: number, busted: boolean, won: boolean}}
 */
export function roll(state, die = rollDie()) {
  const player = current(state);
  const result = applyRoll(player.score, state.turnTotal, die);

  if (result.busted) {
    return { state: { ...nextTurn(state), lastRoll: die, busted: true }, die, busted: true, won: false };
  }
  if (result.reached) {
    const players = state.players.map((p) =>
      p.userId === player.userId ? { ...p, score: p.score + result.turnTotal } : p,
    );
    return {
      state: { ...state, players, turnTotal: 0, lastRoll: die, busted: false, winner: player.userId },
      die,
      busted: false,
      won: true,
    };
  }
  return {
    state: { ...state, turnTotal: result.turnTotal, lastRoll: die, busted: false },
    die,
    busted: false,
    won: false,
  };
}

/** やめる。貯金を持ち点にして次の人へ。 */
export function hold(state) {
  const player = current(state);
  const players = state.players.map((p) =>
    p.userId === player.userId ? { ...p, score: p.score + state.turnTotal } : p,
  );
  return { ...nextTurn({ ...state, players }), lastRoll: null, busted: false, held: state.turnTotal };
}

/** 手番を次の席へ。 */
function nextTurn(state) {
  return { ...state, turn: (state.turn + 1) % state.players.length, turnTotal: 0, held: null };
}

/** 場のぜんぶ。 */
export function potOf(table, state) {
  return table.bet * state.players.length;
}

/** 勝った人に場を渡す。 */
export async function payWinner(db, table, state, userId) {
  const pot = potOf(table, state);
  if (pot > 0) await deposit(db, table.guild_id, userId, pot, 'pig:win', table.id);
  return pot;
}

/** 時間切れで流すときの返金。 */
export async function refundTable(db, table, state) {
  for (const player of state.players) {
    await deposit(db, table.guild_id, player.userId, table.bet, 'pig:refund', table.id);
  }
}

export { GOAL };
