/**
 * ピッグ。サイコロ1個だけの、引き際を competing させるゲーム。
 *
 * 【ルール】
 * 手番の人はサイコロを振り続け、出た目をそのターンの「貯金」に足していく。
 * ただし **1が出たら貯金がぜんぶ消えて手番が移る**。
 * 「やめる」を選べば、貯金をそのまま持ち点にできる。
 * 先に GOAL 点へ届いた人が場を総取り。
 *
 * ルールはこれだけなのに、「あと5点だから振るしかない」「もう十分だから降りる」
 * という判断が毎ターン出てくるのが面白いところ。
 */

/** 先に届いたら勝ち。 */
export const GOAL = 100;

/** これが出たら貯金が消える。 */
export const BUST = 1;

export function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

/**
 * 1回振った結果を返す（状態は変えない）。
 * @returns {{die: number, busted: boolean, turnTotal: number, reached: boolean}}
 */
export function applyRoll(score, turnTotal, die) {
  if (die === BUST) return { die, busted: true, turnTotal: 0, reached: false };
  const next = turnTotal + die;
  return { die, busted: false, turnTotal: next, reached: score + next >= GOAL };
}

/** あと何点で上がれるか。 */
export function remaining(score, turnTotal = 0) {
  return Math.max(0, GOAL - score - turnTotal);
}

/**
 * 進み具合のバー。数字だけだと差が掴みにくいので目で見えるようにする。
 * GOAL を 10 マスに縮めて描く。
 */
export function bar(score, width = 10) {
  const filled = Math.min(width, Math.round((Math.min(score, GOAL) / GOAL) * width));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
