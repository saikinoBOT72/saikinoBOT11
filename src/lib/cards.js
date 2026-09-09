/**
 * トランプの共通部分。
 * 1枚を { rank: 1〜13, suit: 0〜3 } で表す。
 * suit の並びは lib/emoji.js の SUIT_KEYS と同じ（spade / heart / diamond / club）。
 */
import { SUIT_KEYS, cardFace } from './emoji.js';

export const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** 52枚を切った山札。上（末尾）から引く。 */
export function newDeck() {
  const deck = [];
  for (let suit = 0; suit < SUIT_KEYS.length; suit++) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });
  }
  // Fisher–Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 山札から1枚引く（deck を書き換える）。
 * 尽きたら切り直す。ブラックジャックなら4人でも足りるが、念のため。
 */
export function draw(deck) {
  if (deck.length === 0) deck.push(...newDeck());
  return deck.pop();
}

/** カード1枚の見た目。52枚ぶんの絵文字があれば1枚絵、無ければ「スート＋数字」。 */
export function render(emoji, card) {
  return cardFace(emoji, card.suit, card.rank, RANK_LABELS[card.rank]);
}

/** 手札を並べる。伏せ札は裏で出す。 */
export function renderHand(emoji, cards, { hideFrom = null } = {}) {
  return cards
    .map((card, index) => (hideFrom !== null && index >= hideFrom ? emoji.card_back : render(emoji, card)))
    .join(' ');
}
