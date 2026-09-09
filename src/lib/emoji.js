/**
 * 画面で使う絵文字。
 *
 * Unicode の絵文字（Discord では Twemoji として表示される）を既定にしてあるが、
 * サイコロの目とトランプは Unicode に絵文字が無く、文字として細く表示されてしまう。
 * そこは絵文字サーバーにアップロードしたカスタム絵文字に差し替える。
 *
 * ■ カスタム絵文字を用意したら、下の値を `<:名前:数字>` の形に書き換えるだけ。
 *   （アニメーション絵文字なら `<a:名前:数字>`）
 *   どの絵文字を作るかは EMOJI.md にまとめてある。
 */
export const EMOJI = {
  // --- ゲームのアイコン（Unicode のままで Twemoji として表示される） ---
  slot: '🎰',
  coinflip: '🪙',
  highlow: '🃏',
  rps: '✊',
  chinchiro: '🎲',
  poll: '🗳️',
  roulette: '🔫',
  doors: '🚪',
  charge: '⚡',
  mines: '💣',
  lottery: '🎫',

  // --- サイコロの目（Unicode ⚀〜⚅ は絵文字ではないので、要カスタム絵文字） ---
  dice1: '⚀',
  dice2: '⚁',
  dice3: '⚂',
  dice4: '⚃',
  dice5: '⚄',
  dice6: '⚅',
  dice_roll: '🎲',

  // --- トランプのスート（♠️♥️♦️♣️ は絵文字だが、細くて小さい） ---
  spade: '♠️',
  heart: '♥️',
  diamond: '♦️',
  club: '♣️',
  card_back: '🂠',
};

/** サイコロの目6つ。1が添字1になるよう、先頭は空にしてある。 */
export const DICE_FACES = ['', EMOJI.dice1, EMOJI.dice2, EMOJI.dice3, EMOJI.dice4, EMOJI.dice5, EMOJI.dice6];

/** トランプのスート4つ（lib/highlow.js の SUITS と同じ並び）。 */
export const CARD_SUITS = [EMOJI.spade, EMOJI.heart, EMOJI.diamond, EMOJI.club];
