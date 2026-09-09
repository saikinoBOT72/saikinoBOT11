/**
 * 運命の扉。
 *
 * 目の前に赤と青の扉。どちらかが当たりで、当たれば次の扉へ進める。
 * 外れたらそこで終わり、賭けたものは全部なくなる。
 * いつでも「持ち帰る」を選んで、そこまでの取り分を確定できる。
 *
 * 当たる確率はいつも 1/2 なので、公平なら1回ごとに倍。
 * そこから少しだけ差し引いた分が、この賭けの取り分になる。
 */
export const DOORS = {
  red: { label: '赤の扉', emoji: '🟥' },
  blue: { label: '青の扉', emoji: '🟦' },
};

/**
 * 1回当てるごとに倍率が何倍になるか。
 * 当たる確率は 1/2 ちょうどなので、×2 は取り分ゼロ＝完全に五分の賭け。
 * 胴元の取り分が無いぶん、粘っても期待値は減らない（そのかわり当たり外れの振れ幅は大きい）。
 */
export const STEP_MULTIPLIER = 2;

/**
 * 進める回数の上限と、累積倍率の上限。
 * 20回すべて当てると ×1,048,576（2の20乗）。そこまで当たる確率も
 * 約100万分の1なので、期待値としては釣り合っている。
 * 振れ幅が大きすぎると感じたら MAX_MULTIPLIER を下げれば、そこで自動確定になる。
 */
export const MAX_STEPS = 20;
export const MAX_MULTIPLIER = 2 ** MAX_STEPS;

export function openDoor() {
  return Math.random() < 0.5 ? 'red' : 'blue';
}

/** 累積倍率を掛け合わせる。 */
export function multiply(total) {
  return total * STEP_MULTIPLIER;
}

export function payout(bet, multiplier) {
  return Math.floor(bet * Math.min(multiplier, MAX_MULTIPLIER));
}

/** これ以上進めないところまで来たか。 */
export function isCapped(steps, multiplier) {
  return steps >= MAX_STEPS || multiplier >= MAX_MULTIPLIER;
}

/** 結果を大きく出すための見出し。 */
export const HIT_HEADLINE = '# ⭕ あたり！';
export const MISS_HEADLINE = '# ❌ はずれ';

/* ------------------------------------------------------------------ 山分けか、裏切りか */

export const SHARE = {
  split: { label: '山分け', emoji: '🤝' },
  steal: { label: 'ひとりじめ', emoji: '😈' },
};

/**
 * 二人プレイの最後の選択。
 * 二人とも山分け → 半分ずつ。片方だけひとりじめ → その人が全部。
 * 二人ともひとりじめ → 二人とも何ももらえない。
 * @returns {{challenger: number, opponent: number, kind: string}}
 */
export function splitOrSteal(prize, choices) {
  const both = choices.challenger === 'steal' && choices.opponent === 'steal';
  if (both) return { challenger: 0, opponent: 0, kind: 'both-steal' };

  if (choices.challenger === 'steal') return { challenger: prize, opponent: 0, kind: 'challenger-steal' };
  if (choices.opponent === 'steal') return { challenger: 0, opponent: prize, kind: 'opponent-steal' };

  const half = Math.floor(prize / 2);
  // 端数は挑戦者に寄せる（コインを消さないため）
  return { challenger: prize - half, opponent: half, kind: 'split' };
}
