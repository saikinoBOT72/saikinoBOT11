/**
 * チンチロ。サイコロ3つを振って役を competing させる1対1の勝負。
 * 役が出るまで最大3回振り、役の格で勝敗と倍率が決まる。
 */
export const MAX_THROWS = 3;

/** 勝ったときに相手からもらえる倍率の最大値。この分を先に預かる。 */
export const MAX_MULTIPLIER = 5;

const KINDS = {
  pinzoro: { label: 'ピンゾロ', rank: 7, multiplier: 5, emoji: '🌟' },
  zorome: { label: 'ゾロ目', rank: 6, multiplier: 3, emoji: '✨' },
  shigoro: { label: 'シゴロ', rank: 5, multiplier: 2, emoji: '🔥' },
  me: { label: '出目', rank: 4, multiplier: 1, emoji: '🎲' },
  none: { label: '役なし（ションベン）', rank: 2, multiplier: 1, emoji: '💧' },
  hifumi: { label: 'ヒフミ', rank: 1, multiplier: 1, emoji: '💀' },
};

export const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export function rollDice() {
  return [0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6));
}

/** 出目3つから役を判定する。 */
export function evaluate(dice) {
  const sorted = [...dice].sort((a, b) => a - b);
  const [a, b, c] = sorted;

  if (a === b && b === c) {
    const kind = a === 1 ? 'pinzoro' : 'zorome';
    return { ...KINDS[kind], kind, dice, value: a };
  }
  if (a === 4 && b === 5 && c === 6) return { ...KINDS.shigoro, kind: 'shigoro', dice, value: 6 };
  if (a === 1 && b === 2 && c === 3) return { ...KINDS.hifumi, kind: 'hifumi', dice, value: 0 };

  // 2つ同じなら、残りの1つが出目
  if (a === b) return { ...KINDS.me, kind: 'me', dice, value: c };
  if (b === c) return { ...KINDS.me, kind: 'me', dice, value: a };

  return { ...KINDS.none, kind: 'none', dice, value: 0 };
}

/**
 * 役が出るまで振る（最大3回）。
 * @returns {{throws: number[][], hand: object}} 振った履歴と最終的な役
 */
export function rollHand() {
  const throws = [];
  let hand = null;
  for (let i = 0; i < MAX_THROWS; i++) {
    const dice = rollDice();
    throws.push(dice);
    hand = evaluate(dice);
    if (hand.kind !== 'none') break;
  }
  return { throws, hand };
}

/**
 * 挑戦者と受け手の役を比べる。
 * ヒフミを出した側は、相手の役に関係なく負けて2倍払う。
 * それ以外は格の高い方が勝ち、勝った側の役で倍率が決まる。
 *
 * 戻り値の winner は精算側（chinchiro.settle）と同じ言葉にしてある。
 * ここを 'a'/'b' のような別の言葉にすると、取り違えても型では気づけない。
 * @returns {{winner: 'challenger'|'opponent'|'draw', multiplier: number, reason: string}}
 */
export function compare(challengerHand, opponentHand) {
  const challengerHifumi = challengerHand.kind === 'hifumi';
  const opponentHifumi = opponentHand.kind === 'hifumi';
  if (challengerHifumi && opponentHifumi) {
    return { winner: 'draw', multiplier: 0, reason: 'どちらもヒフミ' };
  }
  if (challengerHifumi) return { winner: 'opponent', multiplier: 2, reason: 'ヒフミは2倍払い' };
  if (opponentHifumi) return { winner: 'challenger', multiplier: 2, reason: 'ヒフミは2倍払い' };

  const decide = (challengerWins, reason) => {
    const winner = challengerWins ? 'challenger' : 'opponent';
    const hand = challengerWins ? challengerHand : opponentHand;
    return { winner, multiplier: hand.multiplier, reason };
  };
  if (challengerHand.rank !== opponentHand.rank) {
    return decide(challengerHand.rank > opponentHand.rank, '役の格');
  }
  if (challengerHand.value !== opponentHand.value) {
    return decide(challengerHand.value > opponentHand.value, '出目の大きさ');
  }
  return { winner: 'draw', multiplier: 0, reason: '同じ役' };
}

export function diceLine(dice) {
  return dice.map((value) => DICE_FACES[value]).join(' ');
}

export function handLabel(hand) {
  if (hand.kind === 'me') return `${hand.emoji} 出目 ${hand.value}`;
  return `${hand.emoji} ${hand.label}`;
}
