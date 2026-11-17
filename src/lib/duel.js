/**
 * 1対1の対戦ゲームの共通部分。
 *
 * ロシアンルーレット・チャージ＆シュート・地雷＆陣取り・運命の扉（2人）は、
 * 「挑戦状を出す → 受ける → 賭け金を預かる → 交互（または同時）に操作 → 精算」
 * という流れが同じなので、その骨組みだけをここに置く。
 * ルールごとの中身は state（JSON）に入れて、各ゲームの画面が読み書きする。
 *
 * 同時押しでニ重に処理されないよう、書き込みはすべて version の取り合いにしてある。
 * 「読んだときの version のまま」でなければ書けないので、勝った1リクエストだけが進む。
 */
import { deposit } from './economy.js';
import { chance } from './random.js';
import { recordMatch } from './match-results.js';

export const INVITE_TIMEOUT_MS = 120_000;
export const PLAY_TIMEOUT_MS = 600_000;

export async function createDuel(db, { id, guildId, channelId, game, challengerId, opponentId, bet, escrow, state }) {
  const now = Date.now();
  await db.run(
    `INSERT INTO duels (id, guild_id, channel_id, game, challenger_id, opponent_id, bet, escrow, status, state, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11)`,
    id,
    guildId,
    channelId,
    game,
    challengerId,
    opponentId,
    bet,
    escrow ?? bet,
    JSON.stringify(state ?? {}),
    now + INVITE_TIMEOUT_MS,
    now,
  );
  return getDuel(db, id);
}

export async function getDuel(db, id) {
  return db.get('SELECT * FROM duels WHERE id = ?1', id);
}

export function stateOf(duel) {
  try {
    return JSON.parse(duel.state);
  } catch {
    return {};
  }
}

/** その人がこの対戦のどちら側か。参加者でなければ null。 */
export function roleOf(duel, userId) {
  if (userId === duel.challenger_id) return 'challenger';
  if (userId === duel.opponent_id) return 'opponent';
  return null;
}

export function userIdOf(duel, role) {
  return role === 'challenger' ? duel.challenger_id : duel.opponent_id;
}

export function otherRole(role) {
  return role === 'challenger' ? 'opponent' : 'challenger';
}

export async function setMessageId(db, id, messageId) {
  await db.run('UPDATE duels SET message_id = ?2 WHERE id = ?1', id, messageId);
}

export async function setStatus(db, id, status) {
  await db.run('UPDATE duels SET status = ?2 WHERE id = ?1', id, status);
}

/**
 * pending → playing。先に取れた1つだけが成功する。
 * @returns {Promise<'challenger'|'opponent'|null>} 取れたら先攻の役
 */
export async function startDuel(db, id, { first = null, state = undefined } = {}) {
  const turn = first ?? null;
  const sets = state === undefined ? '' : ', state = ?4';
  const args = [id, turn, Date.now() + PLAY_TIMEOUT_MS];
  if (state !== undefined) args.push(JSON.stringify(state));

  const result = await db.run(
    `UPDATE duels SET status = 'playing', turn = ?2, expires_at = ?3, version = version + 1${sets}
      WHERE id = ?1 AND status = 'pending'`,
    ...args,
  );
  return result.changes === 1 ? (first ?? 'challenger') : null;
}

/**
 * 進行中の対戦を書き換える。読んだときの version と一致するときだけ通る。
 * @returns {Promise<object|null>} 書けたら新しい対戦内容
 */
export async function advance(db, duel, { state, turn = null, status = 'playing' }) {
  const result = await db.run(
    `UPDATE duels SET state = ?3, turn = ?4, status = ?5, version = version + 1, expires_at = ?6
      WHERE id = ?1 AND version = ?2 AND status = 'playing'`,
    duel.id,
    duel.version,
    JSON.stringify(state),
    turn,
    status,
    Date.now() + PLAY_TIMEOUT_MS,
  );
  return result.changes === 1 ? getDuel(db, duel.id) : null;
}

/**
 * 状態を安全に書き換える。
 *
 * 読んで→変えて→書く、のあいだに相手が書き込むと version がずれて書けない。
 * そのときは読み直してやり直す。「自分の選択を入れる」のような操作は
 * やり直しても結果が変わらないので、これで同時押しを正しくさばける。
 *
 * apply は { duel, state } を受け取り、次のどれかを返す:
 *   - { reject: '理由' }                       … 書き込まずに終わる
 *   - { state, turn?, status?, extra? }        … この内容で書き込む
 *
 * @returns {Promise<{ok: true, duel: object, state: object, extra?: any} | {ok: false, reason: string}>}
 */
export async function mutate(db, id, apply, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const duel = await getDuel(db, id);
    if (!duel) return { ok: false, reason: 'missing' };
    if (duel.status !== 'playing') return { ok: false, reason: 'closed' };

    const result = apply({ duel, state: stateOf(duel) });
    if (result?.reject) return { ok: false, reason: result.reject };

    const moved = await advance(db, duel, {
      state: result.state,
      turn: result.turn ?? null,
      status: result.status ?? 'playing',
    });
    if (moved) return { ok: true, duel: moved, state: result.state, extra: result.extra };
  }
  return { ok: false, reason: 'busy' };
}

/** 決着を確定する。取れた1つだけが精算する。 */
export async function finishDuel(db, duel, state = undefined) {
  const result = await db.run(
    `UPDATE duels SET status = 'done', turn = NULL, version = version + 1${state === undefined ? '' : ', state = ?3'}
      WHERE id = ?1 AND version = ?2 AND status = 'playing'`,
    ...(state === undefined ? [duel.id, duel.version] : [duel.id, duel.version, JSON.stringify(state)]),
  );
  return result.changes === 1;
}

/** 預かった額を、決めた配分で返す。合計が預かり総額を超えないこと。 */
export async function payout(db, duel, amounts, reason) {
  for (const [role, amount] of Object.entries(amounts)) {
    if (amount > 0) {
      await deposit(db, duel.guild_id, userIdOf(duel, role), amount, reason, `duel:${duel.id}`);
    }
  }
  // 片方だけが多く受け取ったら、その人の勝ちとして戦績に残す（山分け・返金は残さない）
  if (reason === 'duel:win') {
    const mine = amounts.challenger ?? 0;
    const theirs = amounts.opponent ?? 0;
    if (mine !== theirs) {
      const winner = mine > theirs ? 'challenger' : 'opponent';
      await recordMatch(db, {
        guildId: duel.guild_id,
        game: duel.game,
        winnerId: userIdOf(duel, winner),
        loserId: userIdOf(duel, otherRole(winner)),
        amount: Math.max(mine, theirs),
      });
    }
  }
}

/** 勝った側が総取り。引き分けなら預かりをそのまま返す。 */
export async function settleDuel(db, duel, winner) {
  const pot = duel.escrow * 2;
  if (winner === 'draw') {
    await payout(db, duel, { challenger: duel.escrow, opponent: duel.escrow }, 'duel:refund');
    return { pot: 0 };
  }
  await payout(db, duel, { [winner]: pot }, 'duel:win');
  return { pot };
}

export async function refundDuel(db, duel, reason = 'duel:refund') {
  if (duel.escrow <= 0) return;
  await payout(db, duel, { challenger: duel.escrow, opponent: duel.escrow }, reason);
}

/**
 * 期限切れの対戦を片付ける（1分ごとの定期処理から呼ぶ）。
 *
 * 【放置した人の負け】
 * 時間切れを一律に返金にすると、負けそうな人は手を止めるだけで負けを消せる
 * （ロシアンルーレットで最後の1発を引かずに待つ、など）。
 * そこで、始まっている勝負は「待たせていた人の負け」にする。
 * 誰が待たせていたかはゲームごとに違うので decide に任せる。
 *
 * decide(duel, state) が返すもの:
 *   { kind: 'refund' }                          … 二人とも動いていない。預かりを返す
 *   { kind: 'forfeit', loser: 'challenger' }     … その人の負け。相手が総取り
 *   { kind: 'payout', amounts: {challenger, opponent} } … 決めた配分で払う（運命の扉の山分けなど）
 *
 * 状態を先に書き換え（版番号つき）、取れた1つだけが払う。二重に払わない。
 * @returns {Promise<Array<{duel: object, outcome: object, refunded: boolean}>>}
 */
export async function cancelExpired(db, now = Date.now(), decide = () => ({ kind: 'refund' })) {
  const rows = await db.all(
    "SELECT * FROM duels WHERE status IN ('pending', 'playing') AND expires_at <= ?1 LIMIT 25",
    now,
  );
  const handled = [];
  for (const duel of rows) {
    if (duel.status === 'pending') {
      // 受ける前ならまだお金は動いていない
      const claimed = await db.run("UPDATE duels SET status = 'cancelled' WHERE id = ?1 AND status = 'pending'", duel.id);
      if (claimed.changes === 1) handled.push({ duel, outcome: { kind: 'expired' }, refunded: false });
      continue;
    }

    const outcome = (duel.escrow > 0 ? decide(duel, stateOf(duel)) : null) ?? { kind: 'refund' };
    const claimed = await db.run(
      `UPDATE duels SET status = ?3, turn = NULL, version = version + 1
        WHERE id = ?1 AND version = ?2 AND status = 'playing'`,
      duel.id,
      duel.version,
      outcome.kind === 'refund' ? 'cancelled' : 'done',
    );
    if (claimed.changes !== 1) continue;

    if (outcome.kind === 'forfeit') {
      const { pot } = await settleDuel(db, duel, otherRole(outcome.loser));
      handled.push({ duel, outcome: { ...outcome, pot }, refunded: false });
    } else if (outcome.kind === 'payout') {
      await payout(db, duel, outcome.amounts, 'duel:win');
      handled.push({ duel, outcome, refunded: false });
    } else {
      await refundDuel(db, duel);
      handled.push({ duel, outcome: { kind: 'refund' }, refunded: duel.escrow > 0 });
    }
  }
  return handled;
}

/** 二人同時に選ぶゲームで、選んでいない人だけを負けにする。二人とも選んでいなければ返金。 */
export function forfeitUnchosen(chosen) {
  const missing = ['challenger', 'opponent'].filter((role) => !chosen[role]);
  if (missing.length === 1) return { kind: 'forfeit', loser: missing[0] };
  return { kind: 'refund' };
}

/** どちらが先攻か、コインで決める。 */
export function randomFirst() {
  return chance(0.5) ? 'challenger' : 'opponent';
}
