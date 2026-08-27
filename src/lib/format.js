import { config } from '../config.js';

/** 「🪙 1,234 コイン」の形式に整形する。 */
export function coins(amount, settings) {
  const n = Number(amount).toLocaleString('ja-JP');
  return `${settings.currency_emoji} **${n}** ${settings.currency_name}`;
}

/** 秒数を「1時間30分」のような日本語表記にする。 */
export function duration(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}日`);
  if (h) parts.push(`${h}時間`);
  if (m) parts.push(`${m}分`);
  if (sec && !d && !h) parts.push(`${sec}秒`);
  return parts.length > 0 ? parts.join('') : '0秒';
}

/** 設定タイムゾーンでの「今日 0:00」を epoch ms で返す。 */
export function startOfToday(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const intoDay = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return now.getTime() - intoDay * 1000 - now.getMilliseconds();
}

/** Discord の相対タイムスタンプ表記。 */
export function relative(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
