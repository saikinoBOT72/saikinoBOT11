/**
 * ピッグ。サイコロ1個だけの、引き際を competing させるゲーム。
 *
 * 【ルール】
 * 手番の人はサイコロを振り続け、出た目をそのターンの「貯金」に足していく。
 * 「やめる」を選べば貯金を持ち点にできる。
 * ただし **1が出たら、貯金どころかそれまでの持ち点までぜんぶ0になる**。
 *
 * 1人 TURNS ターンずつやって、最後に持ち点が一番高い人が場を総取り。
 *
 * 【なぜ「全部消える」にしているか】
 * そのターンの貯金だけが消える形だと、点が貯まるほど降りる理由が薄くなり、
 * 結局みんな限界まで回すだけになる。持ち点ごと飛ぶようにすると、
 * 終盤ほど「もう振れない」という判断が重くなって、引き際の読み合いになる。
 */

/** 1人が振れるターン数。 */
export const TURNS = 3;

/** これが出たら持ち点ごと0になる。 */
export const BUST = 1;

export function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

/**
 * 1回振った結果を返す（状態は変えない）。
 * @returns {{die: number, busted: boolean, turnTotal: number}}
 */
export function applyRoll(turnTotal, die) {
  if (die === BUST) return { die, busted: true, turnTotal: 0 };
  return { die, busted: false, turnTotal: turnTotal + die };
}

/** 席順をランダムに並べ替える（先行・後攻を運で決める）。 */
export function shuffleSeats(players) {
  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
