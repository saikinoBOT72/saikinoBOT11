/**
 * 画面で使う絵文字をひとまとめにする場所。
 *
 * 既定は Unicode の絵文字（Discord では Twemoji として表示される）。
 * サーバーにカスタム絵文字を作ったら、管理メニューから `<:name:id>` を入れて
 * 差し替えられる。サイコロの目やトランプのスートのように、Unicode では
 * 絵文字にならない（文字として細く表示される）ものを置き換えるためのしくみ。
 */

/**
 * 差し替えられる絵文字の一覧。
 * twemoji は「この絵文字の Twemoji 画像を使うと揃う」という目安（16進のコードポイント）。
 */
export const SLOTS = {
  // --- ゲームのアイコン ---
  slot: { group: 'ゲーム', label: 'スロット', fallback: '🎰', twemoji: '1f3b0' },
  coinflip: { group: 'ゲーム', label: 'コイントス', fallback: '🪙', twemoji: '1fa99' },
  highlow: { group: 'ゲーム', label: 'ハイ&ロー', fallback: '🃏', twemoji: '1f0cf' },
  rps: { group: 'ゲーム', label: 'じゃんけん', fallback: '✊', twemoji: '270a' },
  chinchiro: { group: 'ゲーム', label: 'チンチロ', fallback: '🎲', twemoji: '1f3b2' },
  poll: { group: 'ゲーム', label: '予想大会', fallback: '🗳️', twemoji: '1f5f3' },
  roulette: { group: 'ゲーム', label: 'ロシアンルーレット', fallback: '🔫', twemoji: '1f52b' },
  doors: { group: 'ゲーム', label: '運命の扉', fallback: '🚪', twemoji: '1f6aa' },
  charge: { group: 'ゲーム', label: 'チャージ＆シュート', fallback: '⚡', twemoji: '26a1' },
  mines: { group: 'ゲーム', label: '地雷＆陣取り', fallback: '💣', twemoji: '1f4a3' },
  lottery: { group: 'ゲーム', label: '宝くじ', fallback: '🎫', twemoji: '1f3ab' },

  // --- サイコロの目（Unicode の ⚀〜⚅ は絵文字ではないので、作ると見栄えが大きく変わる） ---
  dice1: { group: 'サイコロ', label: 'サイコロ 1', fallback: '⚀', twemoji: null },
  dice2: { group: 'サイコロ', label: 'サイコロ 2', fallback: '⚁', twemoji: null },
  dice3: { group: 'サイコロ', label: 'サイコロ 3', fallback: '⚂', twemoji: null },
  dice4: { group: 'サイコロ', label: 'サイコロ 4', fallback: '⚃', twemoji: null },
  dice5: { group: 'サイコロ', label: 'サイコロ 5', fallback: '⚄', twemoji: null },
  dice6: { group: 'サイコロ', label: 'サイコロ 6', fallback: '⚅', twemoji: null },
  dice_roll: { group: 'サイコロ', label: '回転中のサイコロ', fallback: '🎲', twemoji: '1f3b2' },

  // --- トランプ ---
  spade: { group: 'トランプ', label: 'スペード', fallback: '♠️', twemoji: '2660' },
  heart: { group: 'トランプ', label: 'ハート', fallback: '♥️', twemoji: '2665' },
  diamond: { group: 'トランプ', label: 'ダイヤ', fallback: '♦️', twemoji: '2666' },
  club: { group: 'トランプ', label: 'クラブ', fallback: '♣️', twemoji: '2663' },
  card_back: { group: 'トランプ', label: 'カードの裏', fallback: '🂠', twemoji: null },
};

export const SLOT_KEYS = Object.keys(SLOTS);

/** 既定の絵文字だけの一覧。 */
export function defaultEmoji() {
  return Object.fromEntries(SLOT_KEYS.map((key) => [key, SLOTS[key].fallback]));
}

/**
 * 入力された絵文字が使える形か調べる。
 * Unicode の絵文字か `<:name:id>` / `<a:name:id>` だけを通す。
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function normalizeEmoji(input) {
  const text = (input ?? '').trim();
  if (!text) return { ok: false, message: '絵文字を入れてください。' };

  const custom = /^<(a?):(\w{2,32}):(\d{15,25})>$/.exec(text);
  if (custom) return { ok: true, value: text };

  if (/^[<:]/.test(text) || text.includes(':')) {
    return {
      ok: false,
      message:
        'カスタム絵文字は `<:名前:数字>` の形で入れてください。' +
        'メッセージ欄に `\\:絵文字名:` と打って送ると、この形が出てきます。',
    };
  }
  if ([...text].length > 8) return { ok: false, message: '絵文字を1つだけ入れてください。' };
  return { ok: true, value: text };
}

/** サーバーに設定された絵文字（無いものは既定のまま）。 */
export async function loadEmoji(db, guildId) {
  const rows = await db.all('SELECT slot, value FROM guild_emoji WHERE guild_id = ?1', guildId);
  const merged = defaultEmoji();
  for (const row of rows) {
    if (row.slot in merged) merged[row.slot] = row.value;
  }
  return merged;
}

export async function setEmoji(db, guildId, slot, value) {
  if (!(slot in SLOTS)) return false;
  await db.run(
    `INSERT INTO guild_emoji (guild_id, slot, value) VALUES (?1, ?2, ?3)
     ON CONFLICT(guild_id, slot) DO UPDATE SET value = excluded.value`,
    guildId,
    slot,
    value,
  );
  return true;
}

/** 既定に戻す。 */
export async function resetEmoji(db, guildId, slot) {
  const result = await db.run('DELETE FROM guild_emoji WHERE guild_id = ?1 AND slot = ?2', guildId, slot);
  return result.changes > 0;
}

export async function resetAllEmoji(db, guildId) {
  const result = await db.run('DELETE FROM guild_emoji WHERE guild_id = ?1', guildId);
  return result.changes;
}

/** サイコロの目6つを配列で。1が添字1になるよう、先頭は空にしてある。 */
export function diceFaces(emoji) {
  return ['', emoji.dice1, emoji.dice2, emoji.dice3, emoji.dice4, emoji.dice5, emoji.dice6];
}

/** トランプのスート4つ。 */
export function cardSuits(emoji) {
  return [emoji.spade, emoji.heart, emoji.diamond, emoji.club];
}
