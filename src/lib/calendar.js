/**
 * 「1日」の区切りをまとめて決める場所。
 *
 * 午前0時ちょうどで日付が変わると、深夜に遊んでいる人にとっては
 * 「まだ今日のつもり」なのに連続記録が途切れたように見える。
 * そこで、日の始まりを何時にするか（day_start_hour）をずらせるようにしてある。
 * 4 にすると、4:00〜翌3:59 が同じ「1日」になる。
 *
 * どの関数も、タイムゾーン名の文字列をそのまま渡せば「0時始まり」として扱う。
 * 古い呼び出しや、区切りを気にしない場面はそのままでよい。
 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

/** @typedef {{timezone: string, dayStartHour: number}} Calendar */

/** 文字列でもオブジェクトでも受け取れるようにする。 */
export function toCalendar(calendar) {
  if (typeof calendar === 'string') return { timezone: calendar, dayStartHour: 0 };
  return {
    timezone: calendar?.timezone ?? DEFAULT_TIMEZONE,
    dayStartHour: clampHour(calendar?.dayStartHour),
  };
}

export function clampHour(value) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return 0;
  return Math.min(23, Math.max(0, Math.floor(hour)));
}

/**
 * 区切りのぶんだけ時計を戻した瞬間。
 * 「4時始まり」なら、午前2時は前日の22時として扱えばよい、という考え方。
 */
function shifted(calendar, now) {
  const { dayStartHour } = toCalendar(calendar);
  return new Date(now.getTime() - dayStartHour * 3600 * 1000);
}

/** その瞬間が属する「日」を 'YYYY-MM-DD' で返す。 */
export function dateKey(calendar, now = new Date()) {
  const { timezone } = toCalendar(calendar);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted(calendar, now));
}

/** その瞬間が属する「日」の始まり（epoch ms）。 */
export function startOfDay(calendar, now = new Date()) {
  const { timezone, dayStartHour } = toCalendar(calendar);
  const base = shifted(calendar, now);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(base)
      .map((part) => [part.type, part.value]),
  );
  const intoDay = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const midnight = base.getTime() - intoDay * 1000 - base.getMilliseconds();
  return midnight + dayStartHour * 3600 * 1000;
}

/** 'YYYY-MM-DD' の前の日。 */
export function previousDay(key) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** その瞬間の、時計どおりの「時」（0-23）。区切りはずらさない。 */
export function currentHour(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: toCalendar(timezone).timezone,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === 'hour').value) % 24;
}

/** 「1日の区切りは4:00」のような説明。0時始まりなら null。 */
export function describeDayStart(calendar) {
  const { dayStartHour } = toCalendar(calendar);
  if (dayStartHour === 0) return null;
  return `1日の区切りは ${dayStartHour}:00（${dayStartHour}:00〜翌${dayStartHour - 1}:59 が同じ日）`;
}
