/**
 * チャージ＆シュート。
 *
 * 二人が同時に「ためる・ガード・シュート」から選び、いっせいに出す。
 * ためないと撃てないが、ためている間は無防備。ガードはシュートを防ぐ。
 * 体力は2。2回撃たれたら負け。
 */
export const MOVES = {
  charge: { label: 'ためる', emoji: '⚡', cost: -1, hint: 'エネルギーを1ためる。無防備' },
  guard: { label: 'ガード', emoji: '🛡️', cost: 0, hint: 'シュートを防ぐ' },
  shoot: { label: 'シュート', emoji: '🔵', cost: 1, hint: 'エネルギー1。ためている相手に当たる' },
};

/** 体力。これが0になったら負け。 */
export const MAX_HP = 2;

export const MAX_ROUNDS = 30;

/** その手を出せるか。 */
export function canUse(move, energy) {
  const cost = MOVES[move]?.cost;
  if (cost === undefined) return false;
  return cost <= 0 || energy >= cost;
}

/** その手を出したあとのエネルギー。 */
export function nextEnergy(move, energy) {
  const cost = MOVES[move].cost;
  return cost < 0 ? energy + 1 : energy - cost;
}

/**
 * 二人の手を突き合わせて、誰に当たったかを出す。
 * @returns {{hit: 'a'|'b'|null, reason: string}} hit は「当てられた側」
 */
export function resolve(moveA, moveB) {
  const shootA = moveA === 'shoot';
  const shootB = moveB === 'shoot';

  if (shootA && shootB) return { hit: null, reason: 'シュートが相殺' };
  if (shootA && moveB === 'charge') return { hit: 'b', reason: 'ためているところにシュート' };
  if (shootB && moveA === 'charge') return { hit: 'a', reason: 'ためているところにシュート' };
  if (shootA || shootB) return { hit: null, reason: 'シュートはガードに防がれた' };

  if (moveA === 'charge' && moveB === 'charge') return { hit: null, reason: 'どちらもためた' };
  if (moveA === 'guard' && moveB === 'guard') return { hit: null, reason: 'どちらもガード' };
  return { hit: null, reason: '何も起きなかった' };
}

/**
 * 1ラウンド進める。
 * @returns {{damaged: 'challenger'|'opponent'|null, reason: string, hp: object, energy: object, loser: string|null}}
 */
export function playRound(hp, energy, moves) {
  const outcome = resolve(moves.challenger, moves.opponent);
  const damaged = outcome.hit === 'a' ? 'challenger' : outcome.hit === 'b' ? 'opponent' : null;

  const nextHp = { ...hp };
  if (damaged) nextHp[damaged] = Math.max(0, nextHp[damaged] - 1);

  return {
    damaged,
    reason: outcome.reason,
    hp: nextHp,
    energy: {
      challenger: nextEnergy(moves.challenger, energy.challenger),
      opponent: nextEnergy(moves.opponent, energy.opponent),
    },
    loser: damaged && nextHp[damaged] === 0 ? damaged : null,
  };
}

/** ❤️❤️ のような体力の表示。 */
export function hearts(value) {
  return '❤️'.repeat(Math.max(0, value)) + '🖤'.repeat(Math.max(0, MAX_HP - value));
}
