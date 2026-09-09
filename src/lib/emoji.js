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
  dice_1: '⚀',
  dice_2: '⚁',
  dice_3: '⚂',
  dice_4: '⚃',
  dice_5: '⚄',
  dice_6: '⚅',
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
  joker: '🃏',

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

/* ------------------------------------------------------------------ カスタム絵文字 */

/**
 * Developer Portal に上げたアプリケーション絵文字は、名前で引く。
 * 名前 → `<:名前:数字>` の対応を D1 に控えておき（管理メニューから取り込む）、
 * 見つかったものだけ既定の Unicode を上書きする。
 * 見つからなければ既定のまま出るので、一部だけ作った状態でも動く。
 *
 * 絵文字名は大文字小文字を気にしなくていいよう、小文字にそろえて扱う。
 */

/** ハイ&ローの山札（lib/highlow.js の SUITS）と同じ並びの、絵文字名。 */
export const SUIT_KEYS = ['spade', 'heart', 'diamond', 'club'];

/** 1〜13 を絵文字名の末尾に使う形にする（11〜13 は J/Q/K）。 */
export const RANK_NAMES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'j', 'q', 'k'];

/** サイコロの目の絵文字名。 */
export function diceSlot(value) {
  return `dice_${value}`;
}

/** トランプ1枚の絵文字名（例: spade_1, heart_k）。 */
export function cardSlot(suitKey, rank) {
  return `${suitKey}_${RANK_NAMES[rank] ?? rank}`;
}

/** Discord から取ってきた一覧を控える。 */
export async function saveCustomEmoji(db, items) {
  await db.run('DELETE FROM app_emoji');
  const now = Date.now();
  const rows = items
    .filter((item) => item?.name && item?.id)
    .map((item) => [
      'INSERT OR REPLACE INTO app_emoji (name, code, updated_at) VALUES (?1, ?2, ?3)',
      item.name.toLowerCase(),
      `<${item.animated ? 'a' : ''}:${item.name}:${item.id}>`,
      now,
    ]);
  if (rows.length > 0) await db.batch(rows);
  return rows.length;
}

/**
 * 既定の絵文字に、控えてあるカスタム絵文字をかぶせたものを返す。
 * @returns {Promise<Record<string, string>>} 名前 → 絵文字
 */
export async function loadEmoji(db) {
  const merged = { ...EMOJI };
  try {
    for (const row of await db.all('SELECT name, code FROM app_emoji')) {
      merged[row.name] = row.code;
    }
  } catch (error) {
    // 取り込み前でもゲームは動かしたいので、既定のままにする
    console.error('カスタム絵文字の読み込みに失敗:', error);
  }
  return merged;
}

/** サイコロの目6つ。1が添字1になるよう、先頭は空にしてある。 */
export function diceFaces(emoji = EMOJI) {
  return ['', 1, 2, 3, 4, 5, 6].map((value, index) => (index === 0 ? '' : emoji[diceSlot(value)] ?? EMOJI[diceSlot(value)]));
}

/**
 * トランプ1枚の見た目。
 * 52枚ぶんのカスタム絵文字があればそれ1つで、無ければ「スート＋数字」で出す。
 */
export function cardFace(emoji, suitIndex, rank, rankLabel) {
  const custom = emoji[cardSlot(SUIT_KEYS[suitIndex], rank)];
  if (custom) return custom;
  const suit = emoji[SUIT_KEYS[suitIndex]] ?? EMOJI[SUIT_KEYS[suitIndex]];
  return `${suit}${rankLabel}`;
}

/** 既定（Unicode）のサイコロの目。取り込み前や、ライブラリ単体で使うとき用。 */
export const DICE_FACES = diceFaces();
