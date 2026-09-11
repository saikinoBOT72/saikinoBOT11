/**
 * 遊べるゲームの一覧。ここが唯一の名簿。
 *
 * 「🎮 あそぶ」の説明文もボタンも、管理メニューのオンオフ画面も、
 * すべてこの配列から作る。ゲームを増やすときはここに1行足せばよい。
 *
 * key は画面名（customId の `m:<画面>:open` の <画面>）と同じにしてある。
 * オフにしたゲームはボタンを出さないだけでなく、入口でも弾く
 * （前に貼られた古いメッセージのボタンが残っていても入れないように）。
 *
 * オンオフの状態は guild_settings.disabled_games に
 * 「オフにしたものの key をカンマでつないだ文字列」として持つ。
 * 設定は毎回どうせ読むので、専用のテーブルを引くより読み書きが1回分少なくて済む。
 */
import { EMOJI as em } from './emoji.js';
import { MAX_PLAYERS as BJ_MAX_PLAYERS } from './blackjack.js';

/** style は数字ではなく名前で持ち、画面側で ButtonStyle に直す。 */
export const GAMES = [
  { key: 'slot', name: 'スロット', emoji: em.slot, hint: '3つ揃いで最大 x3000', style: 'PRIMARY' },
  { key: 'cf', name: 'コイントス', emoji: em.coinflip, hint: '当たれば2倍', style: 'PRIMARY' },
  { key: 'hl', name: 'ハイ&ロー', emoji: em.highlow, hint: '連勝で倍率上昇。降り際が勝負', style: 'PRIMARY' },
  {
    key: 'bj',
    name: 'ブラックジャック',
    emoji: em.joker,
    hint: `対ディーラー。1人でも、${BJ_MAX_PLAYERS}人で同じ卓でも遊べる`,
    style: 'PRIMARY',
  },
  { key: 'lot', name: '宝くじ', emoji: em.lottery, hint: '毎週日曜に抽選。当たれば持ち越しごと総取り', style: 'PRIMARY' },
  { key: 'fish', name: '釣り', emoji: '🎣', hint: '島でのんびり。釣った魚は図鑑と売り物に', style: 'PRIMARY' },
  { key: 'omi', name: 'おみくじ', emoji: '🎋', hint: '1日1回。コインは動かない、読んで楽しむだけ', style: 'PRIMARY' },
  { key: 'poll', name: '予想大会', emoji: em.poll, hint: 'みんなで賭けて、正解者で山分け', style: 'SUCCESS' },
  {
    key: 'dd',
    name: '運命の扉',
    emoji: em.doors,
    hint: '**2人用**。当て続けて倍率を伸ばし、最後は山分けか裏切りか（1人でも可）',
    style: 'SUCCESS',
  },
  { key: 'rps', name: 'じゃんけん', emoji: em.rps, hint: '1対1。勝てば総取り', style: 'SUCCESS' },
  { key: 'cc', name: 'チンチロ', emoji: em.chinchiro, hint: '1対1。役で倍率が変わる', style: 'SUCCESS' },
  { key: 'rr', name: 'ロシアンルーレット', emoji: em.roulette, hint: '1対1。引くほど当たる確率が上がる', style: 'SUCCESS' },
  { key: 'cs', name: 'チャージ＆シュート', emoji: em.charge, hint: '1対1。ためて撃つ読み合い', style: 'SUCCESS' },
  { key: 'mine', name: '地雷＆陣取り', emoji: em.mines, hint: '1対1。3×3のマスを取り合う', style: 'SUCCESS' },
];

export const GAME_BY_KEY = new Map(GAMES.map((game) => [game.key, game]));

/** 設定の文字列 → オフにした key の集合。 */
export function disabledSet(settings) {
  const raw = settings?.disabled_games ?? '';
  const keys = String(raw)
    .split(',')
    .map((key) => key.trim())
    .filter((key) => GAME_BY_KEY.has(key));
  return new Set(keys);
}

/** 集合 → 設定に入れる文字列。名簿の並び順にそろえておくと差分が読みやすい。 */
export function disabledText(keys) {
  const set = keys instanceof Set ? keys : new Set(keys);
  return GAMES.filter((game) => set.has(game.key))
    .map((game) => game.key)
    .join(',');
}

export function isGameEnabled(settings, key) {
  return !disabledSet(settings).has(key);
}

/** いま遊べるゲームだけを名簿の順に。 */
export function enabledGames(settings) {
  const off = disabledSet(settings);
  return GAMES.filter((game) => !off.has(game.key));
}
