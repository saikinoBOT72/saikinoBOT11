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
 * 全員が TURNS ターン終えた時点で持ち点が一番高い人が総取り。同点なら山分け。
 * 時間切れなら全員に返す。
 */
import { deposit, withdraw } from './economy.js';
import { TURNS, applyRoll, rollDie, shuffleSeats } from './pig.js';
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

/**
 * 始める。
 * 先行・後攻は運で決める（卓を立てた人がいつも先だと有利不利が固定されるため）。
 */
export function start(state) {
  const players = shuffleSeats(state.players).map((player) => ({ ...player, score: 0, turns: 0 }));
  return { ...state, players, turn: 0, turnTotal: 0, lastRoll: null, busted: false, held: null };
}

/**
 * 1回振る。
 * 1が出たら、そのターンの貯金だけでなく **持ち点もまとめて0** になり、手番が移る。
 * @returns {{state: object, die: number, busted: boolean}}
 */
export function roll(state, die = rollDie()) {
  const player = current(state);
  const result = applyRoll(state.turnTotal, die);

  if (result.busted) {
    const wiped = state.players.map((p) => (p.userId === player.userId ? { ...p, score: 0 } : p));
    return {
      state: { ...endTurn({ ...state, players: wiped }), lastRoll: die, busted: true },
      die,
      busted: true,
    };
  }
  return {
    state: { ...state, turnTotal: result.turnTotal, lastRoll: die, busted: false, held: null },
    die,
    busted: false,
  };
}

/** やめる。貯金を持ち点にして手番を終える。 */
export function hold(state) {
  const player = current(state);
  const players = state.players.map((p) =>
    p.userId === player.userId ? { ...p, score: p.score + state.turnTotal } : p,
  );
  return { ...endTurn({ ...state, players }), lastRoll: null, busted: false, held: state.turnTotal };
}

/** 手番を終えて次の席へ。終えた人のターン数を1つ進める。 */
function endTurn(state) {
  const player = current(state);
  const players = state.players.map((p) =>
    p.userId === player.userId ? { ...p, turns: (p.turns ?? 0) + 1 } : p,
  );
  return {
    ...state,
    players,
    turn: (state.turn + 1) % players.length,
    turnTotal: 0,
    held: null,
  };
}

/** 全員が持ちターンを使い切ったか。 */
export function everyoneDone(state) {
  return state.players.every((player) => (player.turns ?? 0) >= TURNS);
}

/** その人の残りターン数。 */
export function turnsLeft(player) {
  return Math.max(0, TURNS - (player.turns ?? 0));
}

/** 持ち点が一番高い人（同点なら全員）。 */
export function winnersOf(state) {
  const best = Math.max(...state.players.map((player) => player.score));
  return state.players.filter((player) => player.score === best);
}

/** 場のぜんぶ。 */
export function potOf(table, state) {
  return table.bet * state.players.length;
}

/**
 * 場を勝った人に渡す。同点なら山分けし、
 * 端数はコインが消えないよう先頭の勝者へ足す。
 * @returns {Promise<{winners: object[], pot: number}>}
 */
export async function payWinners(db, table, state) {
  const pot = potOf(table, state);
  const winners = winnersOf(state);
  const share = Math.floor(pot / winners.length);
  const remainder = pot - share * winners.length;

  for (const [index, winner] of winners.entries()) {
    const amount = share + (index === 0 ? remainder : 0);
    if (amount > 0) await deposit(db, table.guild_id, winner.userId, amount, 'pig:win', table.id);
  }
  return { winners, pot };
}

/** 時間切れで流すときの返金。 */
export async function refundTable(db, table, state) {
  for (const player of state.players) {
    await deposit(db, table.guild_id, player.userId, table.bet, 'pig:refund', table.id);
  }
}

export { TURNS };
