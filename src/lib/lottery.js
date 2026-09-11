/**
 * キャリーオーバー宝くじ。
 *
 * 1枚100コインで **3桁の数字（000〜999）** を予想する。
 * 同じ回に同じ数字は1人しか買えない（早い者勝ち）。
 * 毎週日曜の夜に抽選し、当たった人が **集まった額＋これまでの持ち越し** を総取りする。
 * 当たりが出なければ、その回の売上はまるごと次の回へ持ち越される。
 */
import { deposit, withdraw } from './economy.js';
import { dateKey, previousDay } from './calendar.js';

export const TICKET_PRICE = 100;

/**
 * 最初から積んである元金の既定値。
 * 誰も買っていなくても賞金がこの額から始まるので、1枚目を買う気になる。
 * 当たって払い出したあとも、またここから積み直す。
 *
 * サーバーごとの実際の値は lottery.seed_pool（管理画面から変更できる）。
 * この定数は、列がまだ無い古い行を読んだときの保険として残してある。
 */
export const SEED_POOL = 2000;
export const MAX_TICKETS_PER_USER = 10;
export const MAX_NUMBER = 999;

/** そのサーバーの元金。 */
export function seedPoolOf(lottery) {
  return lottery?.seed_pool ?? SEED_POOL;
}

/** 抽選する曜日と時刻（0=日曜）。 */
export const DRAW_WEEKDAY = 0;
export const DRAW_HOUR = 19;

/** 3桁ゼロ埋め。 */
export function formatNumber(number) {
  return String(number).padStart(3, '0');
}

/**
 * 入力を数字に直す。全角も受け取り、3桁になるまでゼロ埋めして読む。
 * @returns {{ok: true, number: number} | {ok: false, message: string}}
 */
export function parseNumber(input) {
  const normalized = (input ?? '')
    .trim()
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s,，-]/g, '');
  if (!/^\d{1,3}$/.test(normalized)) {
    return { ok: false, message: '000〜999 の数字で入れてください（例: 07 なら 007 として扱います）。' };
  }
  return { ok: true, number: Number(normalized) };
}

/**
 * まとめて買うときの入力。空白・カンマ・改行区切りで複数の数字を読む。
 * 重複は1つにまとめ、おかしいものは理由を集めて返す。
 * @returns {{numbers: number[], errors: string[]}}
 */
export function parseNumbers(input, limit = MAX_TICKETS_PER_USER) {
  const numbers = [];
  const errors = [];
  const seen = new Set();

  const tokens = String(input ?? '')
    .split(/[\s,，、]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');

  for (const token of tokens) {
    if (numbers.length >= limit) {
      errors.push(`${limit}個を超えた分（${token} 以降）は読みませんでした`);
      break;
    }
    const parsed = parseNumber(token);
    if (!parsed.ok) {
      errors.push(`"${token}" は 000〜999 の数字ではありません`);
      continue;
    }
    if (seen.has(parsed.number)) continue;   // 同じ数字を2回書いても1枚
    seen.add(parsed.number);
    numbers.push(parsed.number);
  }
  return { numbers, errors };
}

export function drawNumber() {
  return Math.floor(Math.random() * (MAX_NUMBER + 1));
}

/* ------------------------------------------------------------------ 回（draw）の区切り */

/**
 * その瞬間が属する回の締切日。
 * 日曜19時に抽選するので、日曜19時を過ぎたぶんは「次の日曜」の回になる。
 * @returns {string} 'YYYY-MM-DD'（その回の抽選日）
 */
export function drawKeyFor(calendar, now = new Date()) {
  const today = dateKey(calendar, now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const hour = clockHour(calendar, now);

  // 次の日曜までの日数。日曜の19時を過ぎていたら、その週はもう終わり
  let ahead = (DRAW_WEEKDAY - weekday + 7) % 7;
  if (ahead === 0 && hour >= DRAW_HOUR) ahead = 7;
  return addDays(today, ahead);
}

function clockHour(calendar, now) {
  const timezone = typeof calendar === 'string' ? calendar : calendar.timezone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', hour12: false }).formatToParts(now);
  return Number(parts.find((part) => part.type === 'hour').value) % 24;
}

function addDays(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** いま抽選すべきか（日曜の19時台で、その回をまだ引いていない）。 */
export function isDrawTime(calendar, now = new Date()) {
  const today = dateKey(calendar, now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return weekday === DRAW_WEEKDAY && clockHour(calendar, now) === DRAW_HOUR;
}

/* ------------------------------------------------------------------ 設定 */

export async function getLottery(db, guildId) {
  const row = await db.get('SELECT * FROM lottery WHERE guild_id = ?1', guildId);
  if (row) return row;
  await db.run(
    'INSERT OR IGNORE INTO lottery (guild_id, enabled, carryover, created_at) VALUES (?1, 1, ?2, ?3)',
    guildId,
    SEED_POOL,
    Date.now(),
  );
  return db.get('SELECT * FROM lottery WHERE guild_id = ?1', guildId);
}

export async function setChannel(db, guildId, channelId) {
  await getLottery(db, guildId);
  await db.run('UPDATE lottery SET channel_id = ?2 WHERE guild_id = ?1', guildId, channelId);
  return getLottery(db, guildId);
}

/**
 * 持ち越しと元金を書き換える（管理者用）。
 * undefined を渡した項目は触らない。
 */
export async function setPool(db, guildId, { carryover, seedPool } = {}) {
  await getLottery(db, guildId);
  if (Number.isInteger(carryover)) {
    await db.run('UPDATE lottery SET carryover = ?2 WHERE guild_id = ?1', guildId, Math.max(0, carryover));
  }
  if (Number.isInteger(seedPool)) {
    await db.run('UPDATE lottery SET seed_pool = ?2 WHERE guild_id = ?1', guildId, Math.max(0, seedPool));
  }
  return getLottery(db, guildId);
}

export async function setEnabled(db, guildId, enabled) {
  await getLottery(db, guildId);
  await db.run('UPDATE lottery SET enabled = ?2 WHERE guild_id = ?1', guildId, enabled ? 1 : 0);
  return getLottery(db, guildId);
}

/** 発表する場所が決まっていて、止まっていないサーバー。 */
export async function activeLotteries(db) {
  return db.all('SELECT * FROM lottery WHERE enabled = 1 AND channel_id IS NOT NULL LIMIT 25');
}

/* ------------------------------------------------------------------ 券を買う */

export async function ticketsOf(db, guildId, drawKey) {
  return db.all(
    'SELECT * FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2 ORDER BY number ASC',
    guildId,
    drawKey,
  );
}

export async function myTickets(db, guildId, drawKey, userId) {
  return db.all(
    'SELECT * FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2 AND user_id = ?3 ORDER BY number ASC',
    guildId,
    drawKey,
    userId,
  );
}

export async function poolOf(db, guildId, drawKey) {
  const row = await db.get(
    'SELECT COUNT(*) AS tickets, COALESCE(SUM(price), 0) AS pool FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2',
    guildId,
    drawKey,
  );
  return { tickets: row?.tickets ?? 0, pool: row?.pool ?? 0 };
}

/**
 * 券を1枚買う。
 * 先に席（数字）を取ってから引き落とし、払えなければ席を返す。
 * こうすると「取られたのに買えていない」も「二重に買える」も起きない。
 * @returns {Promise<{ok: true} | {ok: false, reason: 'taken'|'limit'|'insufficient'|'range'}>}
 */
export async function buyTicket(db, guildId, drawKey, userId, number) {
  if (!Number.isInteger(number) || number < 0 || number > MAX_NUMBER) return { ok: false, reason: 'range' };

  const mine = await myTickets(db, guildId, drawKey, userId);
  if (mine.length >= MAX_TICKETS_PER_USER) return { ok: false, reason: 'limit' };

  const claimed = await db.run(
    `INSERT OR IGNORE INTO lottery_tickets (guild_id, draw_key, number, user_id, price, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    guildId,
    drawKey,
    number,
    userId,
    TICKET_PRICE,
    Date.now(),
  );
  if (claimed.changes !== 1) return { ok: false, reason: 'taken' };

  if (!(await withdraw(db, guildId, userId, TICKET_PRICE, 'lottery:buy', `${drawKey} ${formatNumber(number)}`))) {
    await db.run(
      'DELETE FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2 AND number = ?3',
      guildId,
      drawKey,
      number,
    );
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true };
}

/**
 * まとめて買う。買えた分だけ買って、買えなかった理由も返す。
 * 1枚ずつ買うのを繰り返すだけなので、途中で残高が尽きても
 * 「買えた分はちゃんと自分のもの」になる（全部巻き戻したりしない）。
 *
 * 上限に達した・残高が尽きたときは、そこで打ち切る（その先も同じ結果なので）。
 * @returns {Promise<{bought: number[], failed: {number: number, reason: string}[]}>}
 */
export async function buyTickets(db, guildId, drawKey, userId, numbers) {
  const bought = [];
  const failed = [];

  for (const number of numbers) {
    const result = await buyTicket(db, guildId, drawKey, userId, number);
    if (result.ok) {
      bought.push(number);
      continue;
    }
    failed.push({ number, reason: result.reason });
    if (result.reason === 'limit' || result.reason === 'insufficient') break;
  }
  return { bought, failed };
}

/** 空いている番号を count 個ぶん選ぶ。売り切れに近いと足りないこともある。 */
export async function pickFreeNumbers(db, guildId, drawKey, count) {
  const taken = new Set((await ticketsOf(db, guildId, drawKey)).map((row) => row.number));
  const free = [];
  // 1000通りしかないので、埋まっていても必ず有限回で終わる
  for (let attempt = 0; attempt < 400 && free.length < count; attempt++) {
    const number = Math.floor(Math.random() * (MAX_NUMBER + 1));
    if (taken.has(number)) continue;
    taken.add(number);
    free.push(number);
  }
  return free;
}

/* ------------------------------------------------------------------ 抽選 */

/**
 * 1回ぶん抽選する。取れた1つだけが実行する（二重抽選しない）。
 * @returns {Promise<null | {number, winnerId, prize, pool, carryover, tickets}>}
 */
export async function drawLottery(db, lottery, drawKey, number = drawNumber()) {
  // 「この回はもう引いた」を先に立てる。取れなければ誰かが引いている
  const claimed = await db.run(
    'UPDATE lottery SET last_draw_key = ?2 WHERE guild_id = ?1 AND (last_draw_key IS NULL OR last_draw_key != ?2)',
    lottery.guild_id,
    drawKey,
  );
  if (claimed.changes !== 1) return null;

  const { tickets, pool } = await poolOf(db, lottery.guild_id, drawKey);
  const carryover = lottery.carryover;
  const hit = await db.get(
    'SELECT * FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2 AND number = ?3',
    lottery.guild_id,
    drawKey,
    number,
  );

  const prize = hit ? pool + carryover : 0;
  if (hit) {
    await deposit(db, lottery.guild_id, hit.user_id, prize, 'lottery:win', `${drawKey} ${formatNumber(number)}`);
    // 払い出したら、また元金から積み直す
    await db.run('UPDATE lottery SET carryover = ?2 WHERE guild_id = ?1', lottery.guild_id, seedPoolOf(lottery));
  } else {
    await db.run('UPDATE lottery SET carryover = ?2 WHERE guild_id = ?1', lottery.guild_id, carryover + pool);
  }

  await db.run(
    `INSERT OR REPLACE INTO lottery_draws (guild_id, draw_key, number, winner_id, prize, pool, carryover, tickets, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    lottery.guild_id,
    drawKey,
    number,
    hit?.user_id ?? null,
    prize,
    pool,
    carryover,
    tickets,
    Date.now(),
  );

  return { number, winnerId: hit?.user_id ?? null, prize, pool, carryover, tickets };
}

/** 直近の抽選結果。 */
export async function recentDraws(db, guildId, limit = 5) {
  return db.all(
    'SELECT * FROM lottery_draws WHERE guild_id = ?1 ORDER BY draw_key DESC LIMIT ?2',
    guildId,
    limit,
  );
}

/** 抽選が終わった回のキー（発表文で「今回」を指すため）。 */
export function drawnKeyAt(calendar, now = new Date()) {
  return dateKey(calendar, now);
}

export { previousDay };
