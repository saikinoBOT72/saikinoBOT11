/**
 * ブラックジャック（対ディーラー）。
 *
 * 21 を超えない範囲で、ディーラーより大きい手を作れば勝ち。
 * 同じ卓に **3人まで** 座れて、全員がディーラー1人と勝負する（プレイヤー同士は戦わない）。
 *
 * 数え方: A は 11 として数え、21 を超えるなら 1 に落とす。J・Q・K は 10。
 * ディーラーは 17 以上になるまで必ず引き、17 以上なら必ず止まる。
 */
export const MAX_PLAYERS = 3;
export const BLACKJACK = 21;
export const DEALER_STANDS = 17;

/** ブラックジャック（最初の2枚で21）のときの払い戻し。賭け金の2.5倍が戻る＝1.5倍の儲け。 */
export const BLACKJACK_PAYOUT = 2.5;

/** カード1枚の点数。A はひとまず 11 として数える。 */
export function cardPoints(rank) {
  if (rank === 1) return 11;
  return rank >= 10 ? 10 : rank;
}

/**
 * 手札の点数。
 * @returns {{total: number, soft: boolean}} soft は「A を 11 として使っている」状態
 */
export function handValue(cards) {
  let total = cards.reduce((sum, card) => sum + cardPoints(card.rank), 0);
  let aces = cards.filter((card) => card.rank === 1).length;
  while (total > BLACKJACK && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function isBust(cards) {
  return handValue(cards).total > BLACKJACK;
}

/** 最初の2枚で21。3枚以上で21になってもブラックジャックではない。 */
export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === BLACKJACK;
}

/** ディーラーはもう1枚引くか。 */
export function dealerShouldHit(cards) {
  return handValue(cards).total < DEALER_STANDS;
}

/**
 * 勝敗と払い戻し。
 * multiplier は「その手に賭けた額」に対する倍率（0＝没収、1＝そのまま返す、2＝倍）。
 * @returns {{kind: 'blackjack'|'win'|'push'|'lose'|'bust', multiplier: number, label: string}}
 */
export function outcome(playerCards, dealerCards) {
  const player = handValue(playerCards).total;
  const dealer = handValue(dealerCards).total;
  const playerBJ = isBlackjack(playerCards);
  const dealerBJ = isBlackjack(dealerCards);

  if (player > BLACKJACK) return { kind: 'bust', multiplier: 0, label: 'バースト' };
  if (playerBJ && dealerBJ) return { kind: 'push', multiplier: 1, label: '引き分け（両者BJ）' };
  if (playerBJ) return { kind: 'blackjack', multiplier: BLACKJACK_PAYOUT, label: 'ブラックジャック！' };
  if (dealerBJ) return { kind: 'lose', multiplier: 0, label: '負け（ディーラーBJ）' };
  if (dealer > BLACKJACK) return { kind: 'win', multiplier: 2, label: '勝ち（ディーラーバースト）' };
  if (player > dealer) return { kind: 'win', multiplier: 2, label: '勝ち' };
  if (player === dealer) return { kind: 'push', multiplier: 1, label: '引き分け' };
  return { kind: 'lose', multiplier: 0, label: '負け' };
}

/** 実際に戻ってくる額。 */
export function payout(stake, multiplier) {
  return Math.floor(stake * multiplier);
}

/** ダブルダウンできるのは、まだ1枚も引いていない最初の2枚のときだけ。 */
export function canDouble(hand) {
  return hand.cards.length === 2 && !hand.doubled && hand.status === 'playing';
}

/** 点数の表示（A を 11 として使っているときは「soft」が分かるようにする）。 */
export function describeValue(cards) {
  const { total, soft } = handValue(cards);
  if (total > BLACKJACK) return `${total}（バースト）`;
  if (isBlackjack(cards)) return `${total}（BJ）`;
  return soft ? `${total}` : `${total}`;
}
