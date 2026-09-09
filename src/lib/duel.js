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

/** 期限切れの対戦を中止して返金する（1分ごとの定期処理から呼ぶ）。 */
export async function cancelExpired(db, now = Date.now()) {
  const rows = await db.all(
    "SELECT * FROM duels WHERE status IN ('pending', 'playing') AND expires_at <= ?1 LIMIT 25",
    now,
  );
  const handled = [];
  for (const duel of rows) {
    // 先に状態を変えてから返金する（二重返金を防ぐ）
    const claimed = await db.run(
      "UPDATE duels SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'playing')",
      duel.id,
    );
    if (claimed.changes !== 1) continue;
    const refunded = duel.status === 'playing' && duel.escrow > 0;
    if (refunded) await refundDuel(db, duel);
    handled.push({ duel, refunded });
  }
  return handled;
}

/** どちらが先攻か、コインで決める。 */
export function randomFirst() {
  return Math.random() < 0.5 ? 'challenger' : 'opponent';
}
