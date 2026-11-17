/**
 * 掲示に「⏰ 時間切れ」の欄を足す。
 *
 * Discord の <t:秒:R> は「2分後」「30秒後」のように、見る人の画面で勝手に進む。
 * 「2分以内に」と書くより、あとどれだけ残っているかが一目で分かる。
 * （footer の中では <t:…> が動かないので、必ず fields に入れる）
 */
import { relative } from '../lib/format.js';

/** 始まる前（人を待っている）とき。 */
export const WAITING_NOTE = '集まらなければ流れて、参加費は返ります';
/** 始まっているとき。 */
export const PLAYING_NOTE = '動かなかった人の負けになります';

export function stampDeadline(payload, expiresAt, note = null) {
  const first = payload?.embeds?.[0];
  if (!expiresAt || !first || (payload.components ?? []).length === 0) return payload;
  const field = { name: '⏰ 時間切れ', value: `${relative(expiresAt)}${note ? `　${note}` : ''}` };
  return { ...payload, embeds: [{ ...first, fields: [...(first.fields ?? []), field] }, ...payload.embeds.slice(1)] };
}

/** 卓の状態から、添える一言を選ぶ。 */
export function noteFor(table) {
  return table?.status === 'joining' || table?.status === 'pending' ? WAITING_NOTE : PLAYING_NOTE;
}
