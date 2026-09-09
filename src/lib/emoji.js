/**
 * 画面で使う絵文字を、ぜんぶここに集めてある。
 *
 * ■ なぜ集めてあるか
 *   Unicode の絵文字は「どの絵で表示されるか」を端末が決める。
 *   パソコンとブラウザの Discord は Twemoji で描くが、
 *   **iPhone / Android のアプリは端末標準の絵文字**（iOS なら Apple の絵文字）で描く。
 *   つまり Unicode の絵文字を使うかぎり、見る人によって絵柄が変わってしまう。
 *
 *   カスタム絵文字は「画像そのもの」なので、どの端末でも同じ絵で出る。
 *   絵柄を揃えたいなら、Twemoji の画像をカスタム絵文字として登録して、
 *   下の値を `<:名前:数字>` に書き換える（アニメーションなら `<a:名前:数字>`）。
 *
 * ■ 差し替え方
 *   下の値を書き換えるだけ。ほかのファイルは触らなくていい。
 *   どれを作るか・どう渡すかは EMOJI.md にまとめてある。
 */
export const EMOJI = {
  /* --- ゲームのアイコン（メニューのボタンと見出し） --- */
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

  /* --- スロットの絵柄（結果に3つ並ぶ） --- */
  slot_cherry: '🍒',
  slot_lemon: '🍋',
  slot_grape: '🍇',
  slot_bell: '🔔',
  slot_star: '⭐',
  slot_seven: '7️⃣',
  slot_diamond: '💎',

  /* --- じゃんけんの手 --- */
  hand_rock: '✊',
  hand_scissors: '✌️',
  hand_paper: '🖐️',

  /* --- コイントス --- */
  coin_heads: '🪙',
  coin_tails: '🌑',

  /* --- サイコロの目（Unicode ⚀〜⚅ は絵文字ではないので文字として細く出る） --- */
  dice1: '⚀',
  dice2: '⚁',
  dice3: '⚂',
  dice4: '⚃',
  dice5: '⚄',
  dice6: '⚅',
  dice_roll: '🎲',

  /* --- チンチロの役 --- */
  hand_pinzoro: '🌟',
  hand_zorome: '✨',
  hand_shigoro: '🔥',
  hand_me: '🎲',
  hand_none: '💧',
  hand_hifumi: '💀',

  /* --- トランプ（🂠 も絵文字ではない） --- */
  spade: '♠️',
  heart: '♥️',
  diamond: '♦️',
  club: '♣️',
  card_back: '🂠',

  /* --- ロシアンルーレットの弾倉 --- */
  chamber_left: '⚫',
  chamber_spent: '⚪',

  /* --- チャージ＆シュート --- */
  move_charge: '⚡',
  move_guard: '🛡️',
  move_shoot: '🔵',
  hp_full: '❤️',
  hp_lost: '🖤',

  /* --- 地雷＆陣取り --- */
  cell_empty: '⬜',
  cell_challenger: '🟥',
  cell_opponent: '🟦',
  bomb: '💣',
  boom: '💥',

  /* --- 運命の扉 --- */
  door_red: '🟥',
  door_blue: '🟦',
  hit: '⭕',
  miss: '❌',
};

/** サイコロの目6つ。1が添字1になるよう、先頭は空にしてある。 */
export const DICE_FACES = ['', EMOJI.dice1, EMOJI.dice2, EMOJI.dice3, EMOJI.dice4, EMOJI.dice5, EMOJI.dice6];

/** トランプのスート4つ（lib/highlow.js の SUITS と同じ並び）。 */
export const CARD_SUITS = [EMOJI.spade, EMOJI.heart, EMOJI.diamond, EMOJI.club];
