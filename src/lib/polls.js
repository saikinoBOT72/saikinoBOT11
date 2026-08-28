import { deposit, withdraw } from './economy.js';

/** 集めた賭け金を正解者で山分けする「予想大会」。 */
export const MODES = {
  free: { label: '自由な額', hint: '好きな額を賭ける。賭けた額に比例して分ける' },
  fixed: { label: '参加費を決める', hint: '全員同じ額。正解者で等分する' },
};

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 60 * 24 * 7;

/** 正解が決まらないまま放置された大会を返金するまでの期間。 */
export const ABANDON_MS = 7 * 24 * 60 * 60 * 1000;

export async function createPoll(db, { guildId, channelId, ownerId, question, options, mode, stake, minutes }) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO polls (guild_id, channel_id, owner_id, question, mode, stake, status, closes_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8)`,
    guildId,
    channelId,
    ownerId,
    question,
    mode,
    stake,
    now + minutes * 60 * 1000,
    now,
  );
  const pollId = result.lastRowId;
  await db.batch(
    options.map((label, index) => [
      'INSERT INTO poll_options (poll_id, idx, label) VALUES (?1, ?2, ?3)',
      pollId,
      index,
      label,
    ]),
  );
  return getPoll(db, guildId, pollId);
}

export async function getPoll(db, guildId, id) {
  return db.get('SELECT * FROM polls WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function getPollById(db, id) {
  return db.get('SELECT * FROM polls WHERE id = ?1', id);
}

export async function optionsOf(db, pollId) {
  return db.all('SELECT * FROM poll_options WHERE poll_id = ?1 ORDER BY idx ASC', pollId);
}

export async function betsOf(db, pollId) {
  return db.all('SELECT * FROM poll_bets WHERE poll_id = ?1 ORDER BY created_at ASC', pollId);
}

export async function betOf(db, pollId, userId) {
  return db.get('SELECT * FROM poll_bets WHERE poll_id = ?1 AND user_id = ?2', pollId, userId);
}

export async function listPolls(db, guildId, statuses = ['open', 'closed']) {
  const placeholders = statuses.map((_, index) => `?${index + 2}`).join(', ');
  return db.all(
    `SELECT * FROM polls WHERE guild_id = ?1 AND status IN (${placeholders}) ORDER BY closes_at ASC LIMIT 25`,
    guildId,
    ...statuses,
  );
}

/** 選択肢ごとの人数と金額。 */
export async function tally(db, pollId) {
  const rows = await db.all(
    'SELECT option_idx, COUNT(*) AS count, SUM(amount) AS total FROM poll_bets WHERE poll_id = ?1 GROUP BY option_idx',
    pollId,
  );
  const map = new Map(rows.map((row) => [row.option_idx, row]));
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return { byOption: map, total, players: rows.reduce((sum, row) => sum + row.count, 0) };
}

/**
 * 賭ける。1人1択で、あとから変更はできない。
 * 先に席を取ってから引き落とすので、二重に賭けることも取られることもない。
 * @returns {Promise<{ok: true} | {ok: false, reason: 'closed'|'already'|'insufficient'}>}
 */
export async function placeBet(db, poll, userId, optionIdx, amount) {
  if (poll.status !== 'open') return { ok: false, reason: 'closed' };

  const claimed = await db.run(
    'INSERT OR IGNORE INTO poll_bets (poll_id, user_id, option_idx, amount, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    poll.id,
    userId,
    optionIdx,
    amount,
    Date.now(),
  );
  if (claimed.changes !== 1) return { ok: false, reason: 'already' };

  if (!(await withdraw(db, poll.guild_id, userId, amount, 'poll:bet', `poll:${poll.id}`))) {
    await db.run('DELETE FROM poll_bets WHERE poll_id = ?1 AND user_id = ?2', poll.id, userId);
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true };
}

/**
 * 出題者が自腹で賞金を上乗せする。
 * 先にプールへ積んでから引き落とし、払えなければ積んだぶんを戻す。
 * こうしておけば「取られたのに増えていない」が起きない。
 * @returns {Promise<{ok: true, bonus: number} | {ok: false, reason: 'closed'|'insufficient'}>}
 */
export async function addBonus(db, poll, amount) {
  const claimed = await db.run(
    "UPDATE polls SET bonus = bonus + ?2 WHERE id = ?1 AND status IN ('open', 'closed')",
    poll.id,
    amount,
  );
  if (claimed.changes !== 1) return { ok: false, reason: 'closed' };

  if (!(await withdraw(db, poll.guild_id, poll.owner_id, amount, 'poll:bonus', `poll:${poll.id}`))) {
    await db.run('UPDATE polls SET bonus = bonus - ?2 WHERE id = ?1', poll.id, amount);
    return { ok: false, reason: 'insufficient' };
  }
  const fresh = await getPollById(db, poll.id);
  return { ok: true, bonus: fresh.bonus };
}

/** 上乗せぶんを出題者に返す。 */
async function refundBonus(db, poll) {
  if (!poll.bonus) return;
  await deposit(db, poll.guild_id, poll.owner_id, poll.bonus, 'poll:refund', `poll:${poll.id}`);
}

/** 締め切る。取れた1つだけが成功する。 */
export async function closePoll(db, id) {
  const result = await db.run("UPDATE polls SET status = 'closed' WHERE id = ?1 AND status = 'open'", id);
  return result.changes === 1;
}

/**
 * 正解を決めて山分けする。
 * @returns {Promise<{settled: boolean, refunded?: boolean, total?: number, payouts?: Array}>}
 */
export async function settlePoll(db, poll, answerIdx) {
  const claimed = await db.run(
    "UPDATE polls SET status = 'settled', answer = ?2 WHERE id = ?1 AND status IN ('open', 'closed')",
    poll.id,
    answerIdx,
  );
  if (claimed.changes !== 1) return { settled: false };

  const fresh = await getPollById(db, poll.id);
  const bonus = fresh?.bonus ?? 0;
  const bets = await betsOf(db, poll.id);
  const staked = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const total = staked + bonus;
  const winners = bets.filter((bet) => bet.option_idx === answerIdx);

  // 正解者がいない・参加者が1人だけなら成立させず返す（上乗せも出題者に戻す）
  if (winners.length === 0 || bets.length < 2) {
    for (const bet of bets) {
      await deposit(db, poll.guild_id, bet.user_id, bet.amount, 'poll:refund', `poll:${poll.id}`);
    }
    await refundBonus(db, fresh ?? poll);
    return { settled: true, refunded: true, total, staked, bonus, payouts: [] };
  }

  const winnersTotal = winners.reduce((sum, bet) => sum + bet.amount, 0);
  const payouts = winners.map((bet) => ({
    userId: bet.user_id,
    staked: bet.amount,
    amount: Math.floor((total * bet.amount) / winnersTotal),
  }));

  // 端数は一番多く賭けた人に寄せる（コインを消さない）
  const distributed = payouts.reduce((sum, payout) => sum + payout.amount, 0);
  if (total > distributed) {
    const top = payouts.reduce((best, payout) => (payout.staked > best.staked ? payout : best), payouts[0]);
    top.amount += total - distributed;
  }

  for (const payout of payouts) {
    await deposit(db, poll.guild_id, payout.userId, payout.amount, 'poll:win', `poll:${poll.id}`);
  }
  return { settled: true, refunded: false, total, staked, bonus, payouts };
}

/** 締切が来た大会。 */
export async function duePolls(db, now = Date.now()) {
  return db.all("SELECT * FROM polls WHERE status = 'open' AND closes_at <= ?1 LIMIT 25", now);
}

/** 正解が決まらないまま放置された大会。 */
export async function abandonedPolls(db, now = Date.now()) {
  return db.all("SELECT * FROM polls WHERE status = 'closed' AND closes_at <= ?1 LIMIT 25", now - ABANDON_MS);
}

/** 大会を取り消して全額返す（出題者が中止したとき・放置されたとき）。 */
export async function cancelPoll(db, poll) {
  const claimed = await db.run(
    "UPDATE polls SET status = 'cancelled' WHERE id = ?1 AND status IN ('open', 'closed')",
    poll.id,
  );
  if (claimed.changes !== 1) return false;
  for (const bet of await betsOf(db, poll.id)) {
    await deposit(db, poll.guild_id, bet.user_id, bet.amount, 'poll:refund', `poll:${poll.id}`);
  }
  // 取り消しの直前に積まれたぶんも取りこぼさないよう、いまの値を読み直す
  await refundBonus(db, (await getPollById(db, poll.id)) ?? poll);
  return true;
}
