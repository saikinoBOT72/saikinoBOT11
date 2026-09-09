/**
 * チャージ＆シュート。
 *
 * 二人が同時に「ためる・ガード・シュート・ビッグシュート」から選び、いっせいに出す。
 * ためないと撃てないが、ためている間は撃たれる。ガードはタダだがビッグには貫かれる。
 * 「読み合い」で決まる、じゃんけんの発展形。
 */
export const MOVES = {
  charge: { label: 'ためる', emoji: '⚡', cost: -1, hint: 'エネルギーを1ためる。無防備' },
  guard: { label: 'ガード', emoji: '🛡️', cost: 0, hint: 'シュートを防ぐ。ビッグは防げない' },
  shoot: { label: 'シュート', emoji: '🔵', cost: 1, hint: 'エネルギー1。ためている相手に当たる' },
  big: { label: 'ビッグシュート', emoji: '🔴', cost: 3, hint: 'エネルギー3。ガードごと撃ち抜く' },
};

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
 * 二人の手を突き合わせる。
 * @returns {{winner: 'a'|'b'|null, reason: string}} winner が null なら決着なし
 */
export function resolve(moveA, moveB) {
  if (moveA === moveB) return { winner: null, reason: SAME[moveA] };

  const beats = (attacker, defender) => {
    if (attacker === 'big') return defender !== 'big';
    if (attacker === 'shoot') return defender === 'charge';
    return false;
  };
  if (beats(moveA, moveB)) return { winner: 'a', reason: why(moveA, moveB) };
  if (beats(moveB, moveA)) return { winner: 'b', reason: why(moveB, moveA) };

  const pair = [moveA, moveB];
  if (pair.includes('guard') && pair.includes('shoot')) {
    return { winner: null, reason: 'シュートはガードに防がれた' };
  }
  return { winner: null, reason: '何も起きなかった' };
}

const SAME = {
  charge: 'どちらもためた',
  guard: 'どちらもガード',
  shoot: 'シュートが相殺',
  big: 'ビッグシュートが相殺',
};

function why(attacker, defender) {
  if (attacker === 'big' && defender === 'guard') return 'ビッグシュートがガードを撃ち抜いた';
  if (attacker === 'big' && defender === 'shoot') return 'ビッグシュートがシュートを押し切った';
  if (attacker === 'big') return 'ためているところにビッグシュート';
  return 'ためているところにシュート';
}

/** 1ラウンド進める。 */
export function playRound(energy, moves) {
  const outcome = resolve(moves.challenger, moves.opponent);
  const winner = outcome.winner === 'a' ? 'challenger' : outcome.winner === 'b' ? 'opponent' : null;
  return {
    winner,
    reason: outcome.reason,
    energy: {
      challenger: nextEnergy(moves.challenger, energy.challenger),
      opponent: nextEnergy(moves.opponent, energy.opponent),
    },
  };
}
