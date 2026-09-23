/**
 * 丁半博打の盆。
 *
 * 【卓と違うところ】
 * 「席につく」という考え方がない。盆を開いたら、誰でも丁か半にコマを張れる。
 * ボタンを1回押すと一口ぶん（table.bet）。何度でも足せるが、
 * いったん張った側から反対側へは移れない（本物と同じ）。
 *
 * 【お金】
 * 張った瞬間に預かる。開けたら当たった側へ配り、
 * コマがそろわなかった（片方が空）ときと時間切れは全額返す。
 */
import { deposit, withdraw } from './economy.js';
import { CHO, HAN, betOf, ready, rollPair, settle, sideOf, totalOn } from './chohan.js';
import { createTableStore } from './card-table.js';

export const OPEN_TIMEOUT_MS = 180_000;

const store = createTableStore('chohan_tables', {
  emptyState: () => ({ bets: [], dice: null, winningSide: null }),
  joinTimeoutMs: OPEN_TIMEOUT_MS,
  playTimeoutMs: OPEN_TIMEOUT_MS,
});

export const { createTable, getTable, stateOf, setMessageId, setStatus, mutate, expiredTables } = store;

/**
 * コマを張る。先に記録してから引き落とし、払えなければ取り消す。
 * @returns {Promise<{ok: true, state: object} | {ok: false, reason: string}>}
 */
export async function placeBet(db, table, userId, side) {
  const placed = await mutate(
    db,
    table.id,
    ({ state }) => {
      if (state.dice) return { reject: 'opened' };
      const mine = betOf(state.bets, userId);
      if (mine && mine.side !== side) return { reject: 'otherside' };
      const bets = mine
        ? state.bets.map((bet) => (bet.userId === userId ? { ...bet, amount: bet.amount + table.bet } : bet))
        : [...state.bets, { userId, side, amount: table.bet }];
      return { state: { ...state, bets } };
    },
    { allow: ['joining', 'playing'] },
  );
  if (!placed.ok) return placed;

  if (!(await withdraw(db, table.guild_id, userId, table.bet, 'chohan:bet', table.id))) {
    await mutate(
      db,
      table.id,
      ({ state }) => ({
        state: {
          ...state,
          bets: state.bets
            .map((bet) => (bet.userId === userId ? { ...bet, amount: bet.amount - table.bet } : bet))
            .filter((bet) => bet.amount > 0),
        },
      }),
      { allow: ['joining', 'playing'] },
    );
    return { ok: false, reason: 'insufficient' };
  }
  return placed;
}

/**
 * 壺を開ける。コマがそろっていなければ開けずに不成立。
 * 開ける権利は1つの書き込みだけが取れるので、二重に配られない。
 * @returns {Promise<{kind: 'settled', dice, winningSide, result} | {kind: 'unmatched'} | {kind: 'late'}>}
 */
export async function openPot(db, table, dice = rollPair()) {
  const claimed = await mutate(
    db,
    table.id,
    ({ state }) => {
      if (state.dice) return { reject: 'late' };
      if (!ready(state.bets)) return { reject: 'unmatched' };
      return { state: { ...state, dice, winningSide: sideOf(dice) }, status: 'done' };
    },
    { allow: ['joining', 'playing'] },
  );

  if (!claimed.ok) {
    if (claimed.reason !== 'unmatched') return { kind: 'late' };
    await refundTable(db, table, stateOf(await getTable(db, table.id)));
    await setStatus(db, table.id, 'cancelled');
    return { kind: 'unmatched' };
  }

  const winningSide = claimed.state.winningSide;
  const result = settle(claimed.state.bets, winningSide);
  for (const winner of result.winners) {
    if (winner.payout > 0) {
      await deposit(db, table.guild_id, winner.userId, winner.payout, 'chohan:win', table.id);
    }
  }
  return { kind: 'settled', dice, winningSide, result, state: claimed.state, table: claimed.table };
}

/** 張ったぶんを全員に返す（不成立・時間切れ）。 */
export async function refundTable(db, table, state) {
  for (const bet of state.bets) {
    if (bet.amount > 0) await deposit(db, table.guild_id, bet.userId, bet.amount, 'chohan:refund', table.id);
  }
}

export { CHO, HAN, betOf, ready, totalOn };
