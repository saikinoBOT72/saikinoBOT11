/**
 * 5枚ポーカーの役判定。
 *
 * カードは lib/cards.js と同じ { rank: 1〜13, suit: 0〜3 }。
 * 判定の中では A を 14 として扱い、A2345 のときだけ 5 高のストレートとして数える。
 *
 * evaluate() が返す tiebreak は「強い順に並べた比べるための数列」。
 * 同じ役どうしは、この数列を先頭から見比べれば決着する。
 * 例）ワンペアなら [ペアの数, キッカー1, キッカー2, キッカー3]
 */

/** 役の強さ。大きいほど強い。 */
export const HAND_RANKS = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

/** 52枚から5枚を選ぶ全組み合わせでの、役ごとの通り数（数学的に分かっている正解）。 */
export const EXACT_COUNTS = {
  [HAND_RANKS.STRAIGHT_FLUSH]: 40,
  [HAND_RANKS.QUADS]: 624,
  [HAND_RANKS.FULL_HOUSE]: 3744,
  [HAND_RANKS.FLUSH]: 5108,
  [HAND_RANKS.STRAIGHT]: 10200,
  [HAND_RANKS.TRIPS]: 54912,
  [HAND_RANKS.TWO_PAIR]: 123552,
  [HAND_RANKS.PAIR]: 1098240,
  [HAND_RANKS.HIGH]: 1302540,
};

const LABELS = {
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

/** 判定用の数字（2〜14）を見せる文字に。 */
export function rankLabel(value) {
  return LABELS[value] ?? String(value);
}

/** A を 14 として読む。 */
const valueOf = (card) => (card.rank === 1 ? 14 : card.rank);

/**
 * 5枚の役を調べる。
 * @param {{rank: number, suit: number}[]} cards ちょうど5枚
 * @returns {{rank: number, tiebreak: number[], label: string}}
 */
export function evaluate(cards) {
  const values = cards.map(valueOf).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0].suit);

  // 同じ数字が何枚あるか。多い順、同数なら大きい数字順に並べる
  const byValue = new Map();
  for (const value of values) byValue.set(value, (byValue.get(value) ?? 0) + 1);
  const groups = [...byValue.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const straightHigh = straightHighOf(values);

  if (flush && straightHigh) {
    return {
      rank: HAND_RANKS.STRAIGHT_FLUSH,
      tiebreak: [straightHigh],
      label:
        straightHigh === 14
          ? 'ロイヤルストレートフラッシュ'
          : `ストレートフラッシュ（${rankLabel(straightHigh)}高）`,
    };
  }
  if (groups[0].count === 4) {
    return {
      rank: HAND_RANKS.QUADS,
      tiebreak: [groups[0].value, groups[1].value],
      label: `フォーカード（${rankLabel(groups[0].value)}）`,
    };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      tiebreak: [groups[0].value, groups[1].value],
      label: `フルハウス（${rankLabel(groups[0].value)} と ${rankLabel(groups[1].value)}）`,
    };
  }
  if (flush) {
    return { rank: HAND_RANKS.FLUSH, tiebreak: values, label: `フラッシュ（${rankLabel(values[0])}高）` };
  }
  if (straightHigh) {
    return {
      rank: HAND_RANKS.STRAIGHT,
      tiebreak: [straightHigh],
      label: `ストレート（${rankLabel(straightHigh)}高）`,
    };
  }
  if (groups[0].count === 3) {
    return {
      rank: HAND_RANKS.TRIPS,
      tiebreak: [groups[0].value, groups[1].value, groups[2].value],
      label: `スリーカード（${rankLabel(groups[0].value)}）`,
    };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    return {
      rank: HAND_RANKS.TWO_PAIR,
      tiebreak: [groups[0].value, groups[1].value, groups[2].value],
      label: `ツーペア（${rankLabel(groups[0].value)} と ${rankLabel(groups[1].value)}）`,
    };
  }
  if (groups[0].count === 2) {
    return {
      rank: HAND_RANKS.PAIR,
      tiebreak: groups.map((group) => group.value),
      label: `ワンペア（${rankLabel(groups[0].value)}）`,
    };
  }
  return { rank: HAND_RANKS.HIGH, tiebreak: values, label: `ハイカード（${rankLabel(values[0])}）` };
}

/**
 * ストレートなら一番上の数字、違えば null。
 * A2345 だけは A を 1 として読むので 5 高になる。
 */
function straightHighOf(descending) {
  const unique = [...new Set(descending)];
  if (unique.length !== 5) return null;
  if (unique[0] - unique[4] === 4) return unique[0];
  // A 2 3 4 5（14, 5, 4, 3, 2）
  if (unique[0] === 14 && unique[1] === 5 && unique[4] === 2) return 5;
  return null;
}

/**
 * 強さ比べ。a が強ければ 1、b が強ければ -1、まったく同じなら 0。
 * @param {{rank: number, tiebreak: number[]}} a
 * @param {{rank: number, tiebreak: number[]}} b
 */
export function compare(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  for (let index = 0; index < Math.max(a.tiebreak.length, b.tiebreak.length); index++) {
    const left = a.tiebreak[index] ?? 0;
    const right = b.tiebreak[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * 何人かの手を比べて、一番強い人たちを返す（引き分けなら複数）。
 * @param {{userId: string, cards: object[]}[]} hands
 * @returns {{userId: string, hand: object}[]}
 */
export function bestOf(hands) {
  const scored = hands.map((entry) => ({ userId: entry.userId, hand: evaluate(entry.cards) }));
  let winners = [];
  for (const entry of scored) {
    if (winners.length === 0) {
      winners = [entry];
      continue;
    }
    const verdict = compare(entry.hand, winners[0].hand);
    if (verdict > 0) winners = [entry];
    else if (verdict === 0) winners.push(entry);
  }
  return winners;
}
