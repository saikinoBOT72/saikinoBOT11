import { button as makeButton, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { modalResponse, reply, update } from '../discord/respond.js';

/** メニューの customId は `m:<画面>:<操作>:<引数...>`。 */
export const MENU_PREFIX = 'm';

export function id(...parts) {
  return [MENU_PREFIX, ...parts].join(':');
}

/**
 * 画面を表示する。
 * ボタン・セレクト・（メニューから開いた）入力フォームは元のメッセージを書き換え、
 * スラッシュコマンドからは新しく本人だけに見えるメッセージを出す。
 */
export function show(ix, payload) {
  const data = { content: '', embeds: [], components: [], ...payload };
  if (ix.isComponent || (ix.isModalSubmit && ix.fromMessage)) return update(data);
  return reply(data);
}

/** 入力フォームを開く。 */
export function openModal(data) {
  return modalResponse(data);
}

/** 画面の先頭に一言お知らせを差し込む。 */
export function withNotice(embedObject, notice) {
  if (!notice) return embedObject;
  const body = embedObject.description ? `\n\n${embedObject.description}` : '';
  return { ...embedObject, description: `⚠️ ${notice}${body}` };
}

export const button = makeButton;
export { row, embed };

export function backButton(target = 'home', label = '戻る') {
  return button(id(target, 'open'), label, { emoji: '◀️' });
}

export function homeButton() {
  return button(id('home', 'open'), 'メニュー', { emoji: '🏠' });
}

/** 賭け金・金額を選ぶボタン。所持金で足りないものは押せなくする。 */
export const AMOUNT_PRESETS = [10, 50, 100, 500, 1000];

/**
 * @param {string[]} prefix 金額ボタンの宛先（例: ['slot', 'bet'] → m:slot:bet:100）
 * @param {number} balance 所持金。足りない額のボタンは押せなくする
 * @param {{maxBet?: number, extra?: object[], customId?: string}} options
 *   customId は「金額を入力」ボタンの宛先。省略すると同じ画面の custom 操作に送る
 *   （金額ボタンと同じ宛先にすると「custom」を金額として読もうとして壊れる）
 */
export function amountRows(prefix, balance, { maxBet = 0, extra = [], customId } = {}) {
  const buttons = AMOUNT_PRESETS.filter((amount) => maxBet <= 0 || amount <= maxBet).map((amount) =>
    button(id(...prefix, String(amount)), amount.toLocaleString('ja-JP'), {
      style: ButtonStyle.PRIMARY,
      disabled: balance < amount,
    }),
  );
  const custom = customId ?? id(prefix[0], 'custom');
  return [row(...buttons), row(button(custom, '金額を入力', { emoji: '⌨️' }), ...extra)];
}

/** 入力フォームの数値を読む。読めなければ {error} を返す。 */
export function readInt(ix, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const raw = ix.field(field).trim();
  if (raw === '') return fallback;
  const normalized = raw
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, '');
  if (!/^-?\d+$/.test(normalized)) return { error: `「${raw}」は数字として読めませんでした。` };
  const value = Number(normalized);
  if (value < min || value > max) return { error: `${min} 〜 ${max} の範囲で入力してください（入力: ${value}）。` };
  return value;
}

export function isError(value) {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** 入力フォームの任意テキスト（空欄なら null）。 */
export function readText(ix, field) {
  const value = ix.field(field).trim();
  return value === '' ? null : value;
}
