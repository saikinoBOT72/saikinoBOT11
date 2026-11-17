/**
 * 乱数はぜんぶここから取る。
 *
 * 【なぜ Math.random を使わないか】
 * Math.random は速いかわりに、出た値をいくつか見れば次の値を言い当てられる作りになっている。
 * コインが動く場面（カード・サイコロ・宝くじ）でそれを使うと、出目を読まれる余地が残る。
 * ここでは暗号用の乱数（crypto.getRandomValues）から作るので、過去の出目から先は読めない。
 *
 * 【かたよりを作らない】
 * 「0〜2^32 の乱数を n で割った余り」は、n が 2^32 を割り切らないとき小さい数に寄る。
 * 寄るぶんの端を捨てて引き直すことで、どの数も同じ確率で出るようにしている。
 */

const RANGE = 2 ** 32;

function uint32() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0];
}

/** 0 以上 1 未満の数。Math.random と同じ使い方ができる。 */
export function random() {
  return uint32() / RANGE;
}

/** 0 以上 n 未満の整数。どの数も同じ確率で出る。 */
export function randomInt(n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error('randomInt の上限は1以上の整数である必要があります');
  // 端数になる範囲を捨てる（ここに入ったら引き直す）
  const limit = RANGE - (RANGE % n);
  let value = uint32();
  while (value >= limit) value = uint32();
  return value % n;
}

/** サイコロの目のように、1 以上 sides 以下の整数。 */
export function rollDie(sides = 6) {
  return 1 + randomInt(sides);
}

/** 確率 probability で true。 */
export function chance(probability) {
  return random() < probability;
}

/** 配列から1つ選ぶ。 */
export function pick(list) {
  return list[randomInt(list.length)];
}

/** 並べ替えた新しい配列を返す（Fisher–Yates）。元の配列は変えない。 */
export function shuffle(list) {
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
