/**
 * ヨット（ヤッツィー）。サイコロ5個を3回まで振り直して役を作り、
 * 13個ある記入欄を1つずつ埋めていく。全部埋まったら合計点で勝負。
 *
 * 【このゲームの肝】
 * 「いま出ている目を、どの欄に書くか」を毎回選ぶところ。
 * 良い目が出なかったら、どこかの欄を0点で捨てるしかない。
 * その取捨選択が、運だけのゲームとの違いになっている。
 *
 * 【上段ボーナス】
 * 1の目〜6の目の合計が BONUS_LINE 以上なら BONUS 点。
 * 「各目を3個ずつ確保できればちょうど届く」という設計になっている。
 */
export const DICE_COUNT = 5;
export const MAX_ROLLS = 3;

/** 上段の合計がこれ以上ならボーナス。 */
export const BONUS_LINE = 63;
export const BONUS = 35;

/**
 * 記入欄。並び順がそのまま画面の並び順になる。
 * upper が true のものがボーナスの対象。
 */
export const CATEGORIES = [
  { key: 'ones', name: '1の目', upper: true, hint: '1の数 × 1' },
  { key: 'twos', name: '2の目', upper: true, hint: '2の数 × 2' },
  { key: 'threes', name: '3の目', upper: true, hint: '3の数 × 3' },
  { key: 'fours', name: '4の目', upper: true, hint: '4の数 × 4' },
  { key: 'fives', name: '5の目', upper: true, hint: '5の数 × 5' },
  { key: 'sixes', name: '6の目', upper: true, hint: '6の数 × 6' },
  { key: 'three', name: 'スリーカード', upper: false, hint: '同じ目が3個以上あれば、5個の合計' },
  { key: 'four', name: 'フォーカード', upper: false, hint: '同じ目が4個以上あれば、5個の合計' },
  { key: 'full', name: 'フルハウス', upper: false, hint: '3個＋2個ちょうどで 25点' },
  { key: 'small', name: '小ストレート', upper: false, hint: '4個つながれば 30点' },
  { key: 'large', name: '大ストレート', upper: false, hint: '5個つながれば 40点' },
  { key: 'yacht', name: 'ヨット', upper: false, hint: '5個そろえば 50点' },
  { key: 'chance', name: 'チャンス', upper: false, hint: '5個の合計（何でもよい）' },
];

export const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((category) => [category.key, category]));
export const UPPER_KEYS = CATEGORIES.filter((category) => category.upper).map((category) => category.key);

export const FULL_HOUSE = 25;
export const SMALL_STRAIGHT = 30;
export const LARGE_STRAIGHT = 40;
export const YACHT = 50;

export function rollDice(count = DICE_COUNT) {
  return Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
}

/** 残す札を指定して振り直す。keep[i] が true のサイコロはそのまま。 */
export function reroll(dice, keep) {
  return dice.map((die, index) => (keep[index] ? die : 1 + Math.floor(Math.random() * 6)));
}

/** 目ごとの個数。counts[3] は3の目が何個あるか。 */
function countFaces(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const die of dice) counts[die] += 1;
  return counts;
}

const sum = (dice) => dice.reduce((total, die) => total + die, 0);

/** 同じ目が n 個以上あるか。 */
function hasOfAKind(counts, n) {
  return counts.some((count) => count >= n);
}

/** 連続する目が n 個そろっているか。 */
function hasStraight(counts, n) {
  let run = 0;
  for (let face = 1; face <= 6; face++) {
    run = counts[face] > 0 ? run + 1 : 0;
    if (run >= n) return true;
  }
  return false;
}

/**
 * その欄に、いまの出目を書いたら何点になるか。
 * 役ができていなければ 0 点（＝欄を捨てることになる）。
 */
export function scoreFor(key, dice) {
  const counts = countFaces(dice);

  const upperIndex = UPPER_KEYS.indexOf(key);
  if (upperIndex >= 0) {
    const face = upperIndex + 1;
    return counts[face] * face;
  }

  switch (key) {
    case 'three':
      return hasOfAKind(counts, 3) ? sum(dice) : 0;
    case 'four':
      return hasOfAKind(counts, 4) ? sum(dice) : 0;
    // 3個＋2個ちょうど。5個そろい（5+0）はフルハウスにしない
    case 'full':
      return counts.includes(3) && counts.includes(2) ? FULL_HOUSE : 0;
    case 'small':
      return hasStraight(counts, 4) ? SMALL_STRAIGHT : 0;
    case 'large':
      return hasStraight(counts, 5) ? LARGE_STRAIGHT : 0;
    case 'yacht':
      return hasOfAKind(counts, 5) ? YACHT : 0;
    case 'chance':
      return sum(dice);
    default:
      return 0;
  }
}

/** まだ書いていない欄。 */
export function openCategories(card) {
  return CATEGORIES.filter((category) => card[category.key] == null);
}

export function isComplete(card) {
  return openCategories(card).length === 0;
}

/**
 * 集計。上段・ボーナス・下段・合計をまとめて返す。
 * 途中でも呼べるように、書いていない欄は 0 として足す。
 */
export function tally(card) {
  const upper = UPPER_KEYS.reduce((total, key) => total + (card[key] ?? 0), 0);
  const bonus = upper >= BONUS_LINE ? BONUS : 0;
  const lower = CATEGORIES.filter((category) => !category.upper).reduce(
    (total, category) => total + (card[category.key] ?? 0),
    0,
  );
  return { upper, bonus, lower, total: upper + bonus + lower, toBonus: Math.max(0, BONUS_LINE - upper) };
}

/** 空のスコアカード。 */
export function emptyCard() {
  return Object.fromEntries(CATEGORIES.map((category) => [category.key, null]));
}
