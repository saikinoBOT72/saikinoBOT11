/**
 * ルーレット（0〜36のヨーロッパ式。0は緑）。
 *
 * 当たったときの戻り（賭け金ごと）：
 *   赤・黒・偶数・奇数・前半(1-18)・後半(19-36) … ×2
 *   1〜12・13〜24・25〜36 … ×3
 *   数字1つ … ×36
 * 0 はどれにも入らない（数字1つで0に張ったときだけ当たり）。還元率は 36/37 ≈ 97.3%。
 */
import { randomInt } from './random.js';

export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const BETS = {
  red: { label: '赤', emoji: '🔴', multiplier: 2, wins: (n) => RED.has(n) },
  black: { label: '黒', emoji: '⚫', multiplier: 2, wins: (n) => n > 0 && !RED.has(n) },
  even: { label: '偶数', emoji: '2️⃣', multiplier: 2, wins: (n) => n > 0 && n % 2 === 0 },
  odd: { label: '奇数', emoji: '1️⃣', multiplier: 2, wins: (n) => n % 2 === 1 },
  low: { label: '1〜18', emoji: '⬇️', multiplier: 2, wins: (n) => n >= 1 && n <= 18 },
  high: { label: '19〜36', emoji: '⬆️', multiplier: 2, wins: (n) => n >= 19 },
  d1: { label: '1〜12', emoji: '🥉', multiplier: 3, wins: (n) => n >= 1 && n <= 12 },
  d2: { label: '13〜24', emoji: '🥈', multiplier: 3, wins: (n) => n >= 13 && n <= 24 },
  d3: { label: '25〜36', emoji: '🥇', multiplier: 3, wins: (n) => n >= 25 },
};

export const NUMBER_MULTIPLIER = 36;

export function spinWheel() {
  return randomInt(37);
}

export function colorOf(number) {
  if (number === 0) return { label: '緑', emoji: '🟢' };
  return RED.has(number) ? { label: '赤', emoji: '🔴' } : { label: '黒', emoji: '⚫' };
}

/** 張り方と出た数字 → 倍率（外れなら0）。kind が 'num' のときは pick に張った数字。 */
export function multiplierOf(kind, number, pick = null) {
  if (kind === 'num') return pick === number ? NUMBER_MULTIPLIER : 0;
  const bet = BETS[kind];
  return bet && bet.wins(number) ? bet.multiplier : 0;
}

export function betLabel(kind, pick = null) {
  if (kind === 'num') return `数字 ${pick}`;
  return BETS[kind]?.label ?? kind;
}
