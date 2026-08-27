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

/** 指定タイムゾーンでの「今日 0:00」を epoch ms で返す。 */
export function startOfToday(timezone = 'Asia/Tokyo', now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const intoDay = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return now.getTime() - intoDay * 1000 - now.getMilliseconds();
}

/** Discord の相対時刻表記。 */
export function relative(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
