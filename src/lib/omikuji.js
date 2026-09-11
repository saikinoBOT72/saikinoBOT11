/**
 * 1日1回引けるおみくじ。
 *
 * コインは一切動かさない。読んで楽しむだけのもの。
 *
 * 【総合運と各項目の関係】
 * 総合運（大吉・凶など11種）を先に引き、その総合運ごとに決めた確率で
 * 6項目それぞれが 低運 / 中運 / 幸運 のどれかを引く。
 * 「大吉なら幸運5つと中運1つ」のように個数を固定していないので、
 * 大吉でも凶の項目が混じることがあり、毎回の読み味が変わる。
 *
 * 【1日1回の担保】
 * 引いた結果をそのまま保存し、同じ日に開き直したら保存したものを見せる。
 * 引き直しはできない。日付の区切りは他の機能と同じ DAY_START_HOUR に従う。
 */
import { LUCKY_COLORS, LUCKY_ITEMS, OMIKUJI_ITEMS, OMIKUJI_TEXT } from './omikuji-data.js';
import { dateKey } from './calendar.js';

export { OMIKUJI_ITEMS };

/**
 * 総合運。
 *
 * weight は出やすさ。rare を立てたものはチャンネルにも知らせる。
 * odds は「低運・中運・幸運」を引く重みで、合計が100になるようにしてある。
 *
 * 平・吉凶未分末大吉は実在する運勢で、吉凶の階段の外にいる番外枠。
 * とくに吉凶未分末大吉は「今は吉凶が分かれておらぬが最後には大吉」という意味なので、
 * 幸運と低運を半々にして、読むと本当に吉凶が割れているようにしてある。
 */
export const RANKS = [
  { name: '大大大吉', emoji: '🌟', weight: 0.1,  rare: true, odds: { low: 0,  mid: 0,  high: 100 } },
  { name: '大大吉',   emoji: '✨', weight: 0.4,  rare: true, odds: { low: 0,  mid: 6,  high: 94 } },
  { name: '大吉',     emoji: '🎊', weight: 8,               odds: { low: 2,  mid: 18, high: 80 } },
  { name: '中吉',     emoji: '🎋', weight: 15,              odds: { low: 5,  mid: 30, high: 65 } },
  { name: '小吉',     emoji: '🎐', weight: 18,              odds: { low: 10, mid: 40, high: 50 } },
  { name: '吉',       emoji: '🍃', weight: 22,              odds: { low: 18, mid: 47, high: 35 } },
  { name: '末吉',     emoji: '🌾', weight: 18,              odds: { low: 32, mid: 48, high: 20 } },
  { name: '平',       emoji: '⚖️', weight: 3,               odds: { low: 15, mid: 70, high: 15 } },
  { name: '吉凶未分末大吉', emoji: '🌓', weight: 1.5, rare: true, odds: { low: 45, mid: 10, high: 45 } },
  { name: '凶',       emoji: '🌫️', weight: 11,              odds: { low: 62, mid: 30, high: 8 } },
  { name: '大凶',     emoji: '⛈️', weight: 3,               odds: { low: 90, mid: 10, high: 0 } },
];

export const RANK_BY_NAME = new Map(RANKS.map((rank) => [rank.name, rank]));

/** 重み付きの抽選。重みは合計が何であってもよい。 */
function weighted(entries, weightOf, rng) {
  const total = entries.reduce((sum, entry) => sum + weightOf(entry), 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= weightOf(entry);
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1];
}

export function rollRank(rng = Math.random) {
  return weighted(RANKS, (rank) => rank.weight, rng);
}

/** その総合運のもとで、1項目ぶんの段階を引く。 */
export function rollTier(rank, rng = Math.random) {
  const tiers = ['low', 'mid', 'high'].filter((tier) => rank.odds[tier] > 0);
  return weighted(tiers, (tier) => rank.odds[tier], rng);
}

const pick = (list, rng) => Math.floor(rng() * list.length);

/**
 * 1回ぶん引く。保存できる形（添字だけ）で返す。
 * 文そのものを保存しないのは、あとから文言を直しても壊れないようにするため。
 */
export function drawOmikuji(rng = Math.random) {
  const rank = rollRank(rng);
  const picks = OMIKUJI_ITEMS.map((item) => {
    const tier = rollTier(rank, rng);
    return { tier, index: pick(OMIKUJI_TEXT[item][tier], rng) };
  });
  return {
    rank: rank.name,
    picks,
    number: Math.floor(rng() * 1000),
    itemIndex: pick(LUCKY_ITEMS, rng),
    colorIndex: pick(LUCKY_COLORS, rng),
  };
}

/**
 * 保存した形を、画面に出せる形にほどく。
 * 添字が範囲外になっていても（文言を減らしたときなど）落ちないようにする。
 */
export function readOmikuji(draw) {
  const rank = RANK_BY_NAME.get(draw.rank) ?? RANKS[Math.floor(RANKS.length / 2)];
  const lines = OMIKUJI_ITEMS.map((item, position) => {
    const saved = draw.picks?.[position] ?? { tier: 'mid', index: 0 };
    const pool = OMIKUJI_TEXT[item][saved.tier] ?? OMIKUJI_TEXT[item].mid;
    return { item, tier: saved.tier, text: pool[saved.index % pool.length] };
  });
  return {
    rank,
    lines,
    number: String(draw.number ?? 0).padStart(3, '0'),
    item: LUCKY_ITEMS[(draw.itemIndex ?? 0) % LUCKY_ITEMS.length],
    color: LUCKY_COLORS[(draw.colorIndex ?? 0) % LUCKY_COLORS.length],
  };
}

/* ------------------------------------------------------------------ 保存 */

/**
 * 今日ぶんの結果。まだ引いていなければ null。
 * 列名（item_index）と drawOmikuji の形（itemIndex）が違うので、ここで揃える。
 * 揃えないと readOmikuji が既定値の0に落ちて、毎回同じアイテムと色になる。
 */
export async function todaysDraw(db, guildId, userId, calendar) {
  const row = await db.get(
    'SELECT * FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2 AND draw_date = ?3',
    guildId,
    userId,
    dateKey(calendar),
  );
  if (!row) return null;
  return {
    rank: row.rank,
    picks: JSON.parse(row.picks),
    number: row.number,
    itemIndex: row.item_index,
    colorIndex: row.color_index,
  };
}

/**
 * 今日ぶんを引いて保存する。
 * すでに引いていたら引き直さず、保存済みのものを返す（INSERT の件数で判定するので、
 * 同じ瞬間に二度押されても結果が2つできない）。
 * @returns {Promise<{draw: object, fresh: boolean}>}
 */
export async function drawToday(db, guildId, userId, calendar, rng = Math.random) {
  const today = dateKey(calendar);
  const draw = drawOmikuji(rng);
  const saved = await db.run(
    `INSERT OR IGNORE INTO omikuji_draws
       (guild_id, user_id, draw_date, rank, picks, number, item_index, color_index, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    guildId,
    userId,
    today,
    draw.rank,
    JSON.stringify(draw.picks),
    draw.number,
    draw.itemIndex,
    draw.colorIndex,
    Date.now(),
  );
  if (saved.changes === 1) return { draw, fresh: true };
  return { draw: await todaysDraw(db, guildId, userId, calendar), fresh: false };
}

/** これまでに引いた総合運の内訳。 */
export async function rankHistory(db, guildId, userId) {
  const rows = await db.all(
    'SELECT rank, COUNT(*) AS n FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2 GROUP BY rank',
    guildId,
    userId,
  );
  const counts = new Map(rows.map((row) => [row.rank, row.n]));
  return {
    total: rows.reduce((sum, row) => sum + row.n, 0),
    counts,
  };
}
