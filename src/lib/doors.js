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

/** 1回の選択あたりの還元率。1回で降りれば95%。 */
export const RETURN_RATE = 0.95;

/** 1回当てるごとに倍率が何倍になるか（0.95 / 0.5 = 1.9）。 */
export const STEP_MULTIPLIER = Math.round((RETURN_RATE / 0.5) * 100) / 100;

/**
 * 進める回数の上限と、累積倍率の上限。
 * 20回すべて当てると約 ×37万。20連続で当たる確率は約100万分の1なので、
 * 倍率の上限は「20回まで行ける」ことを邪魔しない位置に置いてある。
 * 大きすぎると感じたら MAX_MULTIPLIER を下げれば、そこで自動確定になる。
 */
export const MAX_STEPS = 20;
export const MAX_MULTIPLIER = 400_000;

export function openDoor() {
  return Math.random() < 0.5 ? 'red' : 'blue';
}

/** 累積倍率を掛け合わせる（小数の誤差を溜めないよう都度丸める）。 */
export function multiply(total) {
  return Math.round(total * STEP_MULTIPLIER * 100) / 100;
}

export function payout(bet, multiplier) {
  return Math.floor(bet * Math.min(multiplier, MAX_MULTIPLIER));
}

/** これ以上進めないところまで来たか。 */
export function isCapped(steps, multiplier) {
  return steps >= MAX_STEPS || multiplier >= MAX_MULTIPLIER;
}

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
