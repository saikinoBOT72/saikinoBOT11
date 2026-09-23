/**
 * 丁半博打。壺の中のサイコロ2個の和が偶数（丁）か奇数（半）かに賭ける。
 *
 * 【コマがそろわないと開けない】
 * 本物の丁半は、丁と半に出た金が釣り合わないと勝負にならない。
 * ここでも **片方に誰も張っていなければ不成立**にして、全額返す。
 *
 * 【配当】
 * 当たった側が、外れた側の金を「自分が張った額の比」で分ける。
 * 自分が張った額はそのまま戻るので、受け取りは
 *   張った額 ＋ 外れた側の総額 × 自分の額 ÷ 当たった側の総額
 * 端数はコインが消えないよう、先頭の勝者に足す。
 */
export const CHO = 'cho';
export const HAN = 'han';

export const SIDES = {
  [CHO]: { key: CHO, label: '丁', reading: '偶数', emoji: '🔵' },
  [HAN]: { key: HAN, label: '半', reading: '奇数', emoji: '🔴' },
};

export function rollPair() {
  return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
}

/** 出目2つから丁か半か。 */
export function sideOf(dice) {
  return (dice[0] + dice[1]) % 2 === 0 ? CHO : HAN;
}

/** その側に張られた総額。 */
export function totalOn(bets, side) {
  return bets.filter((bet) => bet.side === side).reduce((sum, bet) => sum + bet.amount, 0);
}

/** 丁と半の両方にコマがあるか（そろっていないと開けない）。 */
export function ready(bets) {
  return totalOn(bets, CHO) > 0 && totalOn(bets, HAN) > 0;
}

/**
 * 配当を計算する。コインが湧いたり消えたりしないことを最優先にしている。
 * @returns {{winners: Array<{userId, stake, payout}>, losers: Array<{userId, stake}>, pot: number}}
 */
export function settle(bets, winningSide) {
  const winning = bets.filter((bet) => bet.side === winningSide);
  const losing = bets.filter((bet) => bet.side !== winningSide);
  const winTotal = winning.reduce((sum, bet) => sum + bet.amount, 0);
  const loseTotal = losing.reduce((sum, bet) => sum + bet.amount, 0);
  const pot = winTotal + loseTotal;

  const winners = winning.map((bet) => ({
    userId: bet.userId,
    stake: bet.amount,
    payout: bet.amount + Math.floor((loseTotal * bet.amount) / winTotal),
  }));
  // 割り切れなかったぶんは先頭へ。場に取り残さない
  const handedOut = winners.reduce((sum, winner) => sum + winner.payout, 0);
  if (winners.length > 0 && handedOut < pot) winners[0].payout += pot - handedOut;

  return { winners, losers: losing.map((bet) => ({ userId: bet.userId, stake: bet.amount })), pot };
}

/** 1人ぶんの持ち金をまとめる（同じ側に何口でも足せる）。 */
export function betOf(bets, userId) {
  return bets.find((bet) => bet.userId === userId) ?? null;
}
