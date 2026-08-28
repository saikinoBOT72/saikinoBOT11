/**
 * ハイ&ロー。
 * 1〜13 のカードを引き、次が上か下かを当てる。当たるたび倍率が掛け算で伸び、
 * いつでも降りて確定できる。同じ数字は引き分けとして引き直す。
 */
export const RANKS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
export const SUITS = ['♠️', '♥️', '♦️', '♣️'];

/**
 * 1回の予想あたりの還元率。
 * 連勝を狙うと掛け算で効いてくるので、1回あたりは高めにしてある。
 * 1回で降りれば約97%、3連勝を狙うと約91%（スロットと同水準）、
 * 10連勝まで粘ると約74%、20連勝なら約54%。「どこで降りるか」が損得を決める。
 */
export const RETURN_RATE = 0.97;

/** 連勝の上限と、累積倍率の上限。青天井にしないための歯止め。 */
export const MAX_STEPS = 20;
export const MAX_MULTIPLIER = 1000;

export function drawCard() {
  return { rank: 1 + Math.floor(Math.random() * 13), suit: SUITS[Math.floor(Math.random() * SUITS.length)] };
}

export function cardLabel(card) {
  return `${card.suit}${RANKS[card.rank] ?? card.rank}`;
}

/**
 * いまのカードから見た「上」「下」の当たる確率。
 * 同じ数字は引き直すので、その分を除いた 12 通りで考える。
 */
export function chances(rank) {
  return { high: (13 - rank) / 12, low: (rank - 1) / 12 };
}

/**
 * この予想に付く倍率。当たりにくいほど高い。
 * 確率0（1でLOW・13でHIGH）は選べないので 0 を返す。
 */
export function stepMultiplier(rank, choice) {
  const chance = chances(rank)[choice];
  if (chance <= 0) return 0;
  return Math.round((RETURN_RATE / chance) * 100) / 100;
}

/** その予想が選べるか（1でLOW、13でHIGHは不可）。 */
export function canChoose(rank, choice) {
  return chances(rank)[choice] > 0;
}

/** @returns {'win'|'lose'|'draw'} */
export function judge(current, next, choice) {
  if (next.rank === current.rank) return 'draw';
  const wentHigh = next.rank > current.rank;
  return (choice === 'high') === wentHigh ? 'win' : 'lose';
}

/** 累積倍率を掛け合わせる（小数の誤差を溜めないよう都度丸める）。 */
export function multiply(total, step) {
  return Math.round(total * step * 100) / 100;
}

export function payout(bet, multiplier) {
  return Math.floor(bet * Math.min(multiplier, MAX_MULTIPLIER));
}
