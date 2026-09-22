/**
 * 5枚ポーカーの卓。
 *
 * 【流れ】
 *   joining … 卓を立てて、2〜4人が座るのを待つ
 *   draw   … 全員に5枚配る。いらない札を選んで引き直す（1回だけ、5枚まで）
 *   bet    … 交換が終わったら「勝負（参加費と同額を追加）」か「降りる」
 *   done   … 残った人で役比べ
 *
 * 【手札の隠し方】
 * 手札は state の中にあるが、公開のメッセージには一切出さない。
 * 「手札を見る」を押した本人にだけ返すことで隠している。
 *
 * 【お金】
 * 座った時点で参加費を預かる。勝負に乗るともう同額を預かる。
 * 降りた人の参加費は場に残り、勝った人が全部持っていく。
 */
import { deposit, withdraw } from './economy.js';
import { draw, newDeck } from './cards.js';
import { bestOf, evaluate } from './poker.js';
import { createTableStore } from './card-table.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const HAND_SIZE = 5;

export const JOIN_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 300_000;

const store = createTableStore('poker_tables', {
  emptyState: () => ({ players: [], deck: [], phase: 'joining' }),
  joinTimeoutMs: JOIN_TIMEOUT_MS,
  playTimeoutMs: PLAY_TIMEOUT_MS,
});

export const { createTable, getTable, stateOf, setMessageId, setStatus, mutate, expiredTables } = store;

export function seatOf(state, userId) {
  return state.players.findIndex((player) => player.userId === userId);
}

export function playerOf(state, userId) {
  return state.players.find((player) => player.userId === userId) ?? null;
}

/** まだ降りていない人。 */
export function stayers(state) {
  return state.players.filter((player) => !player.folded);
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
          players: [
            ...state.players,
            {
              userId,
              cards: [],
              // 残す札。true が残す（最初は全部残す）
              keep: Array(HAND_SIZE).fill(true),
              exchanged: false,
              folded: false,
              called: false,
              staked: table.bet,
            },
          ],
        },
      };
    },
    { allow: ['joining'] },
  );
  if (!claimed.ok) return claimed;

  if (!(await withdraw(db, table.guild_id, userId, table.bet, 'poker:ante', table.id))) {
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

/** 山札を作って全員に5枚ずつ配る。交換の段階に入る。 */
export function deal(state) {
  const deck = newDeck();
  const players = state.players.map((player) => ({
    ...player,
    cards: Array.from({ length: HAND_SIZE }, () => draw(deck)),
    keep: Array(HAND_SIZE).fill(true),
    exchanged: false,
    folded: false,
    called: false,
  }));
  return { ...state, deck, players, phase: 'draw' };
}

/** 「残す／捨てる」を切り替える。 */
export function toggleKeep(state, userId, index) {
  return {
    ...state,
    players: state.players.map((player) =>
      player.userId === userId
        ? { ...player, keep: player.keep.map((keep, at) => (at === index ? !keep : keep)) }
        : player,
    ),
  };
}

/** 捨てると決めた札を引き直す。1人1回だけ。 */
export function exchange(state, userId) {
  const deck = [...state.deck];
  const players = state.players.map((player) => {
    if (player.userId !== userId) return player;
    const cards = player.cards.map((card, index) => (player.keep[index] ? card : draw(deck)));
    return { ...player, cards, exchanged: true };
  });
  return { ...state, deck, players };
}

/** 全員が交換を終えたか。 */
export function everyoneExchanged(state) {
  return state.players.every((player) => player.exchanged);
}

/** 全員が勝負か降りるかを決めたか。 */
export function everyoneDecided(state) {
  return state.players.every((player) => player.called || player.folded);
}

/**
 * 勝負する／降りる。
 * 勝負なら参加費と同額をもう一度預かるので、引き落としは呼び出し側で行う。
 */
export function decide(state, userId, { fold }) {
  return {
    ...state,
    players: state.players.map((player) =>
      player.userId === userId
        ? fold
          ? { ...player, folded: true }
          : { ...player, called: true }
        : player,
    ),
  };
}

/**
 * 決着。
 *  ・2人以上残った → 役比べ。引き分けなら山分け
 *  ・1人だけ残った → 手札を見せずにその人が総取り
 *  ・全員降りた   → 不成立。預かったぶんを全員に返す
 *
 * 山分けの端数は、コインが消えないように先頭の勝者へ足す。
 * @returns {Promise<{kind: 'showdown'|'walkover'|'nobody', pot: number, winners: object[], hands: object[]}>}
 */
export async function settleTable(db, table, state) {
  const pot = state.players.reduce((sum, player) => sum + player.staked, 0);
  const remaining = stayers(state);

  if (remaining.length === 0) {
    for (const player of state.players) {
      if (player.staked > 0) await deposit(db, table.guild_id, player.userId, player.staked, 'poker:refund', table.id);
    }
    return { kind: 'nobody', pot, winners: [], hands: [] };
  }

  if (remaining.length === 1) {
    await deposit(db, table.guild_id, remaining[0].userId, pot, 'poker:win', table.id);
    return { kind: 'walkover', pot, winners: [{ userId: remaining[0].userId, hand: null }], hands: [] };
  }

  const winners = bestOf(remaining.map((player) => ({ userId: player.userId, cards: player.cards })));
  const share = Math.floor(pot / winners.length);
  const remainder = pot - share * winners.length;
  for (const [index, winner] of winners.entries()) {
    const amount = share + (index === 0 ? remainder : 0);
    if (amount > 0) await deposit(db, table.guild_id, winner.userId, amount, 'poker:win', table.id);
  }

  const hands = remaining.map((player) => ({
    userId: player.userId,
    cards: player.cards,
    hand: evaluate(player.cards),
  }));
  return { kind: 'showdown', pot, winners, hands };
}

/** 時間切れで流すときの返金。 */
export async function refundTable(db, table, state) {
  for (const player of state.players) {
    if (player.staked > 0) await deposit(db, table.guild_id, player.userId, player.staked, 'poker:refund', table.id);
  }
}

/** 勝負に乗るぶんを預かる。払えなければ降りた扱いにする。 */
export async function takeCall(db, table, userId) {
  return withdraw(db, table.guild_id, userId, table.bet, 'poker:call', table.id);
}
