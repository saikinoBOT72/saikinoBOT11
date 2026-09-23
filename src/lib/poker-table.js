/**
 * 簡ポーカー（5枚ドロー）の卓。
 *
 * 【流れ】
 *   joining … 卓を立てて、2〜4人が座るのを待つ
 *   draw   … 全員に5枚配る。いらない札を選んで引き直す（2回まで、毎回5枚まで）
 *   bet    … 交換が終わったら「勝負」「レイズ」「降りる」
 *   done   … 残った人で役比べ
 *
 * 【手札の隠し方】
 * 手札は state の中にあるが、公開のメッセージには一切出さない。
 * 「手札を見る」を押した本人にだけ返すことで隠している。
 *
 * 【お金】
 * 座った時点で参加費を預かる。勝負に乗るともう同額を預かる。
 * 降りた人の参加費は場に残り、勝った人が全部持っていく。
 *
 * 【レイズ】
 * 「提案する周」と「承認する周」を繰り返す形にしてある。何度でも上げられる。
 * 払うのは自分が押した瞬間の自分のぶんだけなので、
 * 他人から先に集めて後で返す、という危ない後始末が要らない。
 */
import { deposit, withdraw } from './economy.js';
import { draw, newDeck, sortHand } from './cards.js';
import { bestOf, evaluate } from './poker.js';
import { createTableStore } from './card-table.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const HAND_SIZE = 5;
/** 引き直せる回数。途中でやめてもよい。 */
export const MAX_DRAWS = 2;

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
              // 引き直した回数と、交換を終えたかどうか
              draws: 0,
              exchanged: false,
              folded: false,
              // この勝負で場に足した額
              paid: 0,
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
    cards: sortHand(Array.from({ length: HAND_SIZE }, () => draw(deck))),
    keep: Array(HAND_SIZE).fill(true),
    draws: 0,
    exchanged: false,
    folded: false,
    paid: 0,
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

/**
 * 捨てると決めた札を引き直す。1人 MAX_DRAWS 回まで。
 * 引き直したら並べ直すので、残す／捨てるの指定はいったん全部「残す」に戻る。
 */
export function exchange(state, userId) {
  const deck = [...state.deck];
  const players = state.players.map((player) => {
    if (player.userId !== userId) return player;
    const cards = sortHand(player.cards.map((card, index) => (player.keep[index] ? card : draw(deck))));
    const draws = (player.draws ?? 0) + 1;
    return { ...player, cards, keep: Array(HAND_SIZE).fill(true), draws, exchanged: draws >= MAX_DRAWS };
  });
  return { ...state, deck, players };
}

/** 引き直さずに交換を終える（「これで勝負へ」）。 */
export function standPat(state, userId) {
  return {
    ...state,
    players: state.players.map((player) =>
      player.userId === userId ? { ...player, exchanged: true } : player,
    ),
  };
}

/** 全員が交換を終えたか。 */
export function everyoneExchanged(state) {
  return state.players.every((player) => player.exchanged);
}

/* ------------------------------------------------------------------ 勝負の段階 */

/**
 * 勝負の段階は「提案の周」と「承認の周」を行ったり来たりする。
 *
 *   propose … 降りる／乗る／レイズを提案。全員が動いたら閉じる
 *              → 誰も提案しなければ役比べへ
 *              → 一番高い提案が通って accept へ
 *   accept  … 上がったぶんを払う（承認）か、降りる
 *              → 2人以上残っていれば propose に戻る（何度でもレイズできる）
 *
 * 【お金の動き】
 * 払うのは「自分のぶんを、自分が押した瞬間に」だけ。
 * ほかの人から先に集めることはしないので、集めたあとで中止して返す、
 * といった後始末がいらない。承認までに払えなくなっていたら降りた扱いにする。
 */
export const PROPOSE = 'propose';
export const ACCEPT = 'accept';

/** 周のはじめに戻す持ちもの。 */
const freshRound = (player) => ({ ...player, acted: false, proposal: 0 });

/**
 * 勝負の段階に入る。level は「この段階で1人が場に出しておく額」。
 * 最初は参加費と同額で、レイズが通るたび上がる。
 */
export function toBetPhase(state, bet) {
  return { ...state, phase: 'bet', step: PROPOSE, level: bet, players: state.players.map(freshRound) };
}

/** この人があと払わないといけない額。 */
export function owedBy(state, player) {
  return Math.max(0, (state.level ?? 0) - (player.paid ?? 0));
}

/** 場に足す（乗る・承認する）。レイズを出すときは proposal も置く。引き落としは呼び出し側。 */
export function actInRound(state, userId, { amount, proposal = 0 }) {
  return {
    ...state,
    players: state.players.map((player) =>
      player.userId === userId
        ? {
            ...player,
            acted: true,
            proposal,
            paid: (player.paid ?? 0) + amount,
            staked: player.staked + amount,
          }
        : player,
    ),
  };
}

/** 降りる。すでに場に出したぶんは戻らない。 */
export function foldPlayer(state, userId) {
  return {
    ...state,
    players: state.players.map((player) =>
      player.userId === userId ? { ...player, folded: true, acted: true, proposal: 0 } : player,
    ),
  };
}

/** 一番高い提案。誰も出していなければ 0。 */
export function bestProposal(state) {
  return stayers(state).reduce((best, player) => Math.max(best, player.proposal ?? 0), 0);
}

/** 提案の周が終わったか。1人しか残っていなければ、待たずに閉じる。 */
export function proposeRoundOver(state) {
  return stayers(state).length <= 1 || state.players.every((player) => player.folded || player.acted);
}

/** 承認の周が終わったか。 */
export function acceptRoundOver(state) {
  return state.players.every((player) => player.folded || owedBy(state, player) === 0);
}

/**
 * 提案の周を閉じる。
 * 誰もレイズしていなければ役比べへ。出ていれば一番高いぶんだけ level を上げて承認の周へ。
 */
export function closeProposeRound(state) {
  const raise = bestProposal(state);
  if (raise <= 0) return { ...state, phase: 'done' };
  return { ...state, step: ACCEPT, level: (state.level ?? 0) + raise, lastRaise: raise };
}

/** 承認の周を閉じる。残りが2人以上なら、また提案の周から。 */
export function closeAcceptRound(state) {
  if (stayers(state).length <= 1) return { ...state, phase: 'done' };
  return { ...state, step: PROPOSE, players: state.players.map(freshRound) };
}

/**
 * レイズできる上限。
 * 「卓に残っている全員が払える額」までに抑える。
 * 提案してから承認されるまでのあいだに使われてしまうことはあるので、
 * そのときは承認できずに降りた扱いになる（払えない人を待たない）。
 * @param balances {Record<string, number>} userId → 所持金
 */
export function raiseCap(state, balances) {
  const caps = stayers(state).map((player) => (balances[player.userId] ?? 0) - owedBy(state, player));
  return Math.max(0, Math.min(...caps));
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

/** 時間切れで流すときの返金。場に出したぶんを全員に返す。 */
export async function refundTable(db, table, state) {
  for (const player of state.players) {
    if (player.staked > 0) await deposit(db, table.guild_id, player.userId, player.staked, 'poker:refund', table.id);
  }
}

/** 勝負に乗るぶんを預かる。払えなければ false。 */
export async function takeCall(db, table, userId, amount) {
  if (amount <= 0) return true;
  return withdraw(db, table.guild_id, userId, amount, 'poker:call', table.id);
}

/** 記録できなかったときに引き落としを取り消す。 */
export async function giveBack(db, table, userId, amount) {
  if (amount > 0) await deposit(db, table.guild_id, userId, amount, 'poker:refund', table.id);
}
