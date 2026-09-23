/**
 * ヨットの卓。
 *
 * 【順番待ちがない】
 * ヨットは相手の手が自分の手に影響しない。だから順番に回す必要がなく、
 * 全員が同時に自分のカードを進められる。誰も待たされない。
 *
 * 【手札の隠し方】
 * 出目もカードも state の中にあるが、公開の掲示には合計点しか出さない。
 * 「カードを開く」を押した本人にだけ中身を返す。
 *
 * 【お金】
 * 座った時点で参加費を預かり、全員が書き終えたら一番高い人が総取り。
 * 同点なら山分け。参加費0の卓は「ひとり練習」で、お金は動かない。
 */
import { deposit, withdraw } from './economy.js';
import {
  DICE_COUNT,
  MAX_ROLLS,
  emptyCard,
  isComplete,
  reroll,
  rollDice,
  scoreFor,
  tally,
} from './yacht.js';
import { createTableStore } from './card-table.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export const JOIN_TIMEOUT_MS = 120_000;
/** 13欄ぶん書くので、ほかの卓より長めに持たせる。 */
export const PLAY_TIMEOUT_MS = 900_000;

const store = createTableStore('yacht_tables', {
  emptyState: () => ({ players: [] }),
  joinTimeoutMs: JOIN_TIMEOUT_MS,
  playTimeoutMs: PLAY_TIMEOUT_MS,
});

export const { createTable, getTable, stateOf, setMessageId, setStatus, mutate, expiredTables } = store;

/** ひとり練習の卓か（参加費0）。 */
const isSolo = (table) => table.bet === 0;

/** 始めるのに必要な人数。ひとり練習なら1人。 */
export const neededPlayers = (table) => (isSolo(table) ? 1 : MIN_PLAYERS);

export function seatOf(state, userId) {
  return state.players.findIndex((player) => player.userId === userId);
}

export function playerOf(state, userId) {
  return state.players.find((player) => player.userId === userId) ?? null;
}

const freshTurn = () => ({ dice: [], keep: Array(DICE_COUNT).fill(false), rolls: 0 });

/** 席につく。先に席を取ってから引き落とし、払えなければ席を返す。 */
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
          players: [...state.players, { userId, card: emptyCard(), done: false, ...freshTurn() }],
        },
      };
    },
    { allow: ['joining'] },
  );
  if (!claimed.ok) return claimed;

  // 参加費0（ひとり練習）なら引き落とさない
  if (table.bet > 0 && !(await withdraw(db, table.guild_id, userId, table.bet, 'yacht:ante', table.id))) {
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

/** その人の番の持ちものだけを書き換える。 */
function updatePlayer(state, userId, change) {
  return {
    ...state,
    players: state.players.map((player) => (player.userId === userId ? { ...player, ...change } : player)),
  };
}

/** 振る。1回目は5個全部、2回目からは残していないぶんだけ。 */
export function rollFor(state, userId, forced = null) {
  const player = playerOf(state, userId);
  const dice = forced ?? (player.rolls === 0 ? rollDice() : reroll(player.dice, player.keep));
  return updatePlayer(state, userId, { dice, rolls: player.rolls + 1 });
}

/** 残す／捨てるを切り替える。 */
export function toggleKeep(state, userId, index) {
  const player = playerOf(state, userId);
  return updatePlayer(state, userId, {
    keep: player.keep.map((keep, at) => (at === index ? !keep : keep)),
  });
}

/** いまの出目を1つの欄に書き込む。書いたら次の欄へ。 */
export function writeScore(state, userId, key) {
  const player = playerOf(state, userId);
  const card = { ...player.card, [key]: scoreFor(key, player.dice) };
  return updatePlayer(state, userId, { card, done: isComplete(card), ...freshTurn() });
}

/** まだ振れるか。 */
export function canRoll(player) {
  return player.rolls < MAX_ROLLS;
}

/** 書き込めるか（1回でも振っていれば書ける）。 */
export function canWrite(player) {
  return player.rolls > 0;
}

export function everyoneDone(state) {
  return state.players.length > 0 && state.players.every((player) => player.done);
}

/** 得点順。同点は席順のまま。 */
export function standings(state) {
  return state.players
    .map((player) => ({ userId: player.userId, ...tally(player.card) }))
    .sort((a, b) => b.total - a.total);
}

export function potOf(table, state) {
  return table.bet * state.players.length;
}

/**
 * 決着。一番高い人が総取り、同点なら山分け。
 * 端数はコインが消えないよう先頭の勝者へ足す。
 */
export async function settleTable(db, table, state) {
  const ranked = standings(state);
  const best = ranked[0]?.total ?? 0;
  const winners = ranked.filter((entry) => entry.total === best);
  const pot = potOf(table, state);

  if (pot > 0) {
    const share = Math.floor(pot / winners.length);
    const remainder = pot - share * winners.length;
    for (const [index, winner] of winners.entries()) {
      const amount = share + (index === 0 ? remainder : 0);
      if (amount > 0) await deposit(db, table.guild_id, winner.userId, amount, 'yacht:win', table.id);
    }
  }
  return { ranked, winners, pot };
}

/** 時間切れで流すときの返金。 */
export async function refundTable(db, table, state) {
  if (table.bet <= 0) return;
  for (const player of state.players) {
    await deposit(db, table.guild_id, player.userId, table.bet, 'yacht:refund', table.id);
  }
}

/* ------------------------------------------------------------------ 自己ベスト */

export async function getRecord(db, guildId, userId) {
  return (
    (await db.get('SELECT * FROM yacht_records WHERE guild_id = ?1 AND user_id = ?2', guildId, userId)) ?? {
      best: 0,
      plays: 0,
    }
  );
}

/**
 * 1枚書き終えたので記録を更新する。
 * @returns {Promise<{best: number, plays: number, renewed: boolean}>}
 */
export async function recordScore(db, guildId, userId, score) {
  const before = await getRecord(db, guildId, userId);
  const best = Math.max(before.best, score);
  await db.run(
    `INSERT INTO yacht_records (guild_id, user_id, best, plays, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       best = MAX(yacht_records.best, excluded.best),
       plays = yacht_records.plays + 1,
       updated_at = excluded.updated_at`,
    guildId,
    userId,
    score,
    Date.now(),
  );
  return { best, plays: before.plays + 1, renewed: score > before.best };
}

export { MAX_ROLLS, DICE_COUNT };
