/**
 * スロットの出目テーブル。
 * weight は各リールでの出現比率、payout3 は3つ揃い、payout2 は2つ揃いの配当倍率。
 * この設定で理論還元率(RTP)は約 91.7%、当選率は約 11.8%。
 */
export const SLOT_SYMBOLS = [
  { symbol: '🍒', weight: 26, payout3: 5, payout2: 0 },
  { symbol: '🍋', weight: 22, payout3: 8, payout2: 0 },
  { symbol: '🍇', weight: 16, payout3: 15, payout2: 0 },
  { symbol: '🔔', weight: 11, payout3: 45, payout2: 3 },
  { symbol: '⭐', weight: 7, payout3: 150, payout2: 8 },
  { symbol: '7️⃣', weight: 3, payout3: 600, payout2: 15 },
  { symbol: '💎', weight: 1, payout3: 3000, payout2: 40 },
];

const TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

function spinReel() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const s of SLOT_SYMBOLS) {
    roll -= s.weight;
    if (roll < 0) return s;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

/**
 * 1回スピンする。
 * @returns {{reels: string[], multiplier: number, kind: 'triple'|'double'|'lose', symbol: string|null}}
 */
export function spin() {
  const reels = [spinReel(), spinReel(), spinReel()];
  const [a, b, c] = reels;
  if (a.symbol === b.symbol && b.symbol === c.symbol) {
    return { reels: reels.map((r) => r.symbol), multiplier: a.payout3, kind: 'triple', symbol: a.symbol };
  }
  const paired = reels.find((r, i) => reels.findIndex((x) => x.symbol === r.symbol) !== i);
  if (paired && paired.payout2 > 0) {
    return { reels: reels.map((r) => r.symbol), multiplier: paired.payout2, kind: 'double', symbol: paired.symbol };
  }
  return { reels: reels.map((r) => r.symbol), multiplier: 0, kind: 'lose', symbol: null };
}

/** 配当表を Embed 用の文字列で返す。 */
export function payoutTable() {
  const lines = SLOT_SYMBOLS.slice()
    .reverse()
    .map((s) => {
      const two = s.payout2 > 0 ? ` / 2つ **x${s.payout2}**` : '';
      return `${s.symbol}${s.symbol}${s.symbol} **x${s.payout3}**${two}`;
    });
  return lines.join('\n');
}
