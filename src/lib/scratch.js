/**
 * スクラッチくじ。
 *
 * 買った瞬間に当たり外れが決まり、そのまま精算する（本物のスクラッチと同じ）。
 * 削るのは見せ方だけで、削る順番や途中でやめることで結果は変わらない。
 *
 * 【当たりの決め方】先に「何が当たるか」を確率で決め、それに合うカードを作る。
 *   💎×3 → ×50（0.4%）/ 🍀×3 → ×10（2%）/ 🔔×3 → ×5（4%）/ 🍒×3 → ×2（15%）
 *   還元率は 0.2 + 0.2 + 0.2 + 0.3 = 90%、当たる確率は 21.4%。
 * 外れのカードは、どの絵柄も2つまでにする（3つそろって見えると当たりと紛らわしいため）。
 */
import { random, shuffle } from './random.js';

export const SYMBOLS = ['💎', '🍀', '🔔', '🍒', '⭐', '🍋'];

/** 当たりの段（SYMBOLS の番号・倍率・確率）。 */
export const TIERS = [
  { symbol: 0, multiplier: 50, chance: 0.004 },
  { symbol: 1, multiplier: 10, chance: 0.02 },
  { symbol: 2, multiplier: 5, chance: 0.04 },
  { symbol: 3, multiplier: 2, chance: 0.15 },
];

function drawTier(roll = random()) {
  let left = roll;
  for (const tier of TIERS) {
    if (left < tier.chance) return tier;
    left -= tier.chance;
  }
  return null;
}

/** 9マスのカード。winner があればその絵柄を3つ、ほかは2つまで。 */
function buildCells(winner) {
  const cells = [];
  if (winner !== null) cells.push(winner, winner, winner);
  const others = SYMBOLS.map((_, index) => index).filter((index) => index !== winner);
  const pool = shuffle(others.flatMap((index) => [index, index]));
  while (cells.length < 9) cells.push(pool.pop());
  return shuffle(cells);
}

export function newTicket(roll = random()) {
  const tier = drawTier(roll);
  return {
    cells: buildCells(tier ? tier.symbol : null),
    multiplier: tier?.multiplier ?? 0,
    symbol: tier ? tier.symbol : null,
  };
}

/** 3つそろった絵柄（無ければ null）。カードから数え直すので、保存した中身と食い違わない。 */
export function winnerOf(cells) {
  for (let symbol = 0; symbol < SYMBOLS.length; symbol++) {
    if (cells.filter((cell) => cell === symbol).length >= 3) return symbol;
  }
  return null;
}

export const ALL_REVEALED = (1 << 9) - 1;
