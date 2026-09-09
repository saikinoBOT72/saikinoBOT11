/**
 * ロシアンルーレット。
 *
 * 弾倉は6つ、実弾は1発。回転させずに順番に引くので、
 * 1回目は 1/6、外れれば次は 1/5、その次は 1/4 …と、引くたびに追い詰められる。
 * （最初に「何回目で当たるか」を決めておけば、この確率になる）
 */
export const CHAMBERS = 6;

/** 何回目の引き金で実弾が来るかを決める。1〜6。 */
export function loadBullet() {
  return 1 + Math.floor(Math.random() * CHAMBERS);
}

/** k回目（1始まり）を引くときに当たる確率。 */
export function chanceAt(pull) {
  return 1 / (CHAMBERS - pull + 1);
}

/** 残りの弾倉の数。 */
export function chambersLeft(pulled) {
  return CHAMBERS - pulled;
}

/** 弾倉の見た目。引き終わったところは空、残りは伏せたまま。 */
export function cylinder(pulled) {
  return Array.from({ length: CHAMBERS }, (_, index) => (index < pulled ? '⚪' : '⚫')).join(' ');
}
