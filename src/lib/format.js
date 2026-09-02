import { startOfDay } from './calendar.js';

/** 「🪙 1,234 コイン」の形に整える。 */
export function coins(amount, settings) {
  return `${settings.currency_emoji} **${Number(amount).toLocaleString('ja-JP')}** ${settings.currency_name}`;
}

/** 秒数を「1時間30分」のような日本語にする。 */
export function duration(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  if (rest && !days && !hours) parts.push(`${rest}秒`);
  return parts.length > 0 ? parts.join('') : '0秒';
}

/** その瞬間が属する「日」の始まりを epoch ms で返す（区切りは calendar.js が決める）。 */
export function startOfToday(calendar = 'Asia/Tokyo', now = new Date()) {
  return startOfDay(calendar, now);
}

/** Discord の相対時刻表記。 */
export function relative(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
