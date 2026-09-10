/**
 * 釣りゲームの中身（魚・竿・餌・確率・値段）。
 *
 * ここには D1 も Discord も出てこない。数値と純粋な計算だけなので、
 * テストから直接呼んで期待値を検証できる。
 *
 * 【設計の軸】
 * ・餌 20 コインを払って1回投げる。1時間におよそ 100 回投げられる想定。
 * ・ノーマル平均 10 / レア平均 100 / スーパーレア平均 1000 コイン。
 * ・竿を上げるほど当たりが良くなるが、いちばん上の伝説でも
 *   期待値は 1時間あたり +500 コインに届かない。竿代は回収できない前提。
 */

/** 魚の絵文字名は fish_1 … fish_78。図鑑の並び順でもある。 */
export const FISH = [
  // ── ノーマル（実在する、比較的しょぼい魚）──
  { id: 1,  name: 'マアジ',        rarity: 'n',  size: 25,  price: 12 },
  { id: 2,  name: 'サンマ',        rarity: 'n',  size: 30,  price: 11 },
  { id: 3,  name: 'カサゴ',        rarity: 'n',  size: 22,  price: 14 },
  { id: 4,  name: 'カワハギ',      rarity: 'n',  size: 20,  price: 16 },
  { id: 5,  name: 'ヒラメ',        rarity: 'r',  size: 55,  price: 105 },
  { id: 6,  name: 'マアナゴ',      rarity: 'n',  size: 45,  price: 15 },
  { id: 7,  name: 'マイワシ',      rarity: 'n',  size: 18,  price: 6 },
  { id: 8,  name: 'シロギス',      rarity: 'n',  size: 22,  price: 13 },
  { id: 9,  name: 'メバル',        rarity: 'n',  size: 24,  price: 14 },
  { id: 10, name: 'クロダイ',      rarity: 'n',  size: 40,  price: 19 },
  { id: 11, name: 'マコガレイ',    rarity: 'n',  size: 33,  price: 17 },
  { id: 12, name: 'ボラ',          rarity: 'n',  size: 50,  price: 7 },
  { id: 13, name: 'マサバ',        rarity: 'n',  size: 35,  price: 12 },
  { id: 14, name: 'ハゼ',          rarity: 'n',  size: 15,  price: 6 },
  { id: 15, name: 'アイナメ',      rarity: 'n',  size: 32,  price: 15 },
  { id: 16, name: 'メジナ',        rarity: 'n',  size: 35,  price: 13 },
  { id: 17, name: 'マゴチ',        rarity: 'n',  size: 45,  price: 18 },
  { id: 18, name: 'コノシロ',      rarity: 'n',  size: 22,  price: 7 },
  { id: 19, name: 'カタクチイワシ', rarity: 'n',  size: 13,  price: 4 },
  { id: 20, name: 'ベラ',          rarity: 'n',  size: 20,  price: 8 },
  { id: 21, name: 'イサキ',        rarity: 'n',  size: 30,  price: 18 },
  { id: 22, name: 'ウミタナゴ',    rarity: 'n',  size: 20,  price: 8 },
  { id: 23, name: 'ホウボウ',      rarity: 'n',  size: 30,  price: 17 },
  { id: 24, name: 'スズメダイ',    rarity: 'n',  size: 13,  price: 5 },
  { id: 25, name: 'ソウダガツオ',  rarity: 'n',  size: 40,  price: 9 },

  // ── レア（実在する、良い魚）──
  { id: 26, name: 'マダイ',        rarity: 'r',  size: 50,  price: 115 },
  { id: 27, name: 'スズキ',        rarity: 'r',  size: 60,  price: 80 },
  { id: 28, name: 'イシダイ',      rarity: 'r',  size: 40,  price: 95 },
  { id: 29, name: 'アマダイ',      rarity: 'r',  size: 35,  price: 85 },
  { id: 30, name: 'キンメダイ',    rarity: 'r',  size: 40,  price: 100 },
  { id: 31, name: 'ブリ',          rarity: 'r',  size: 80,  price: 95 },
  { id: 32, name: 'カンパチ',      rarity: 'r',  size: 70,  price: 100 },
  { id: 33, name: 'ヒラマサ',      rarity: 'r',  size: 75,  price: 95 },
  { id: 34, name: 'シマアジ',      rarity: 'r',  size: 45,  price: 120 },
  { id: 35, name: 'マハタ',        rarity: 'r',  size: 50,  price: 110 },
  { id: 36, name: 'クエ',          rarity: 'r',  size: 80,  price: 130 },

  // ── スーパーレア（実在しない、この島だけの魚）──
  { id: 37, name: '金のシャチホコ',  rarity: 'sr', size: 60,  price: 820 },
  { id: 38, name: '宝石ガニ',        rarity: 'sr', size: 30,  price: 680 },
  { id: 39, name: '宇宙ヒラメ',      rarity: 'sr', size: 70,  price: 910 },
  { id: 40, name: 'ガラスのサメ',    rarity: 'sr', size: 120, price: 1000 },
  { id: 41, name: 'ドラゴンシャーク', rarity: 'sr', size: 200, price: 1455 },
  { id: 42, name: '地球ガメ',        rarity: 'sr', size: 90,  price: 1135 },

  // ── ノーマル（外道・魚ですらないもの）──
  { id: 43, name: 'サッパ',        rarity: 'n',  size: 15,  price: 5 },
  { id: 44, name: 'クサフグ',      rarity: 'n',  size: 15,  price: 4 },
  { id: 45, name: 'メゴチ',        rarity: 'n',  size: 20,  price: 9 },
  { id: 46, name: 'ウツボ',        rarity: 'n',  size: 70,  price: 11 },
  { id: 47, name: 'ヒイラギ',      rarity: 'n',  size: 12,  price: 4 },
  { id: 48, name: 'ヒトデ',        rarity: 'n',  size: 18,  price: 4 },
  { id: 49, name: 'サヨリ',        rarity: 'n',  size: 30,  price: 14 },
  { id: 50, name: 'アイゴ',        rarity: 'n',  size: 28,  price: 6 },
  { id: 51, name: 'アカエイ',      rarity: 'n',  size: 90,  price: 8 },
  { id: 52, name: 'ゴンズイ',      rarity: 'n',  size: 18,  price: 4 },
  { id: 53, name: 'ネンブツダイ',  rarity: 'n',  size: 12,  price: 4 },
  { id: 54, name: 'コウイカ',      rarity: 'n',  size: 20,  price: 17 },
  { id: 55, name: 'カマス',        rarity: 'n',  size: 35,  price: 13 },
  { id: 56, name: 'タカノハダイ',  rarity: 'n',  size: 35,  price: 6 },
  { id: 57, name: 'シャコ',        rarity: 'n',  size: 15,  price: 16 },
  { id: 58, name: 'エソ',          rarity: 'n',  size: 40,  price: 5 },
  { id: 59, name: 'ムツゴロウ',    rarity: 'n',  size: 15,  price: 12 },
  { id: 60, name: 'クラゲ',        rarity: 'n',  size: 25,  price: 4 },
  { id: 61, name: 'ダツ',          rarity: 'n',  size: 60,  price: 6 },
  { id: 62, name: 'ミノカサゴ',    rarity: 'n',  size: 30,  price: 10 },
  { id: 63, name: 'アメフラシ',    rarity: 'n',  size: 20,  price: 4 },
  { id: 64, name: 'トビウオ',      rarity: 'n',  size: 35,  price: 15 },
  { id: 65, name: 'ギンポ',        rarity: 'n',  size: 25,  price: 12 },
  { id: 66, name: 'ヤドカリ',      rarity: 'n',  size: 10,  price: 4 },

  // ── レア（続き）──
  { id: 67, name: 'クロマグロ',    rarity: 'r',  size: 150, price: 120 },
  { id: 68, name: 'タチウオ',      rarity: 'r',  size: 100, price: 65 },
  { id: 69, name: 'トラフグ',      rarity: 'r',  size: 45,  price: 125 },
  { id: 70, name: 'ノドグロ',      rarity: 'r',  size: 35,  price: 120 },
  { id: 71, name: 'マツカワ',      rarity: 'r',  size: 55,  price: 105 },
  { id: 72, name: 'イセエビ',      rarity: 'r',  size: 30,  price: 115 },
  { id: 73, name: 'カツオ',        rarity: 'r',  size: 60,  price: 55 },
  { id: 74, name: 'サワラ',        rarity: 'r',  size: 80,  price: 70 },
  { id: 75, name: 'キンキ',        rarity: 'r',  size: 30,  price: 120 },
  { id: 76, name: 'オニオコゼ',    rarity: 'r',  size: 25,  price: 105 },
  { id: 77, name: 'イシガキダイ',  rarity: 'r',  size: 45,  price: 90 },
  { id: 78, name: 'アオリイカ',    rarity: 'r',  size: 40,  price: 80 },
];

export const FISH_BY_ID = new Map(FISH.map((fish) => [fish.id, fish]));

export const RARITY = {
  n:  { key: 'n',  label: 'ノーマル',       color: 0x9aa7b2 },
  r:  { key: 'r',  label: 'レア',           color: 0x35b0a8 },
  sr: { key: 'sr', label: 'スーパーレア',   color: 0xf2a65a },
};

export const RARITIES = ['n', 'r', 'sr'];

/** 餌1つの値段。1回投げるごとに1つ消える。 */
export const BAIT_PRICE = 20;

/** 餌をまとめ買いするときの単位。 */
export const BAIT_PACKS = [10, 50, 100];

/**
 * 竿。hit は「かかる魚のレア度の出方」で、合計 1 になる。
 * 上の竿ほどレアが出やすいが、値段は釣りの儲けでは一生回収できない。
 * コインの捨て先として置いてある。
 */
export const RODS = [
  { key: 'bamboo', name: '竹の竿',      price: 0,      hit: { n: 0.937, r: 0.0600, sr: 0.0030 } },
  { key: 'glass',  name: 'グラスの竿',  price: 5000,   hit: { n: 0.920, r: 0.0750, sr: 0.0050 } },
  { key: 'carbon', name: 'カーボンの竿', price: 30000,  hit: { n: 0.904, r: 0.0885, sr: 0.0075 } },
  { key: 'legend', name: '伝説の竿',    price: 150000, hit: { n: 0.893, r: 0.0970, sr: 0.0100 } },
];

export const RODS_BY_KEY = new Map(RODS.map((rod) => [rod.key, rod]));
export const DEFAULT_ROD = 'bamboo';

/** 竿を強い順に見たときの位置。買い直しの判定に使う。 */
export function rodRank(key) {
  return RODS.findIndex((rod) => rod.key === key);
}

/**
 * 取り込みの難しさ。レア度と大きさで決まる。
 *
 * ・pull   引いたときにテンションが上がる速さ
 * ・ease   離したときに下がる速さ
 * ・safe   安全な帯の広さ（0〜1 のうちどれだけ）
 * ・needed 取り込みに必要な進み（秒あたり 1 として何秒ぶんか）
 *
 * 帯は狭く、引きは強く、必要な時間も長くしてあるので、遊ぶ側は手応えがある。
 * ただし「気を抜かなければ landRate くらいは取れる」ところを狙っている
 * （難しさは"操作の忙しさ"で出し、"取り逃がす率"では出さない）。
 * landRate はお金の設計に直結するので、ここを動かすと稼ぎが変わる。
 */
const FIGHT = {
  n:  { pull: 0.95, ease: 0.68, safe: 0.38, needed: 3.8, landRate: 0.98 },
  r:  { pull: 1.30, ease: 0.80, safe: 0.25, needed: 6.0, landRate: 0.90 },
  sr: { pull: 1.70, ease: 0.92, safe: 0.17, needed: 8.5, landRate: 0.75 },
};

/** 大きい個体ほど強い。size 倍率 0.5〜1.5 を 0.85〜1.15 の補正に落とす。 */
function sizeBoost(sizeMultiplier) {
  return 0.85 + (sizeMultiplier - 0.5) * 0.3;
}

export function fightParams(fish, sizeMultiplier) {
  const base = FIGHT[fish.rarity];
  const boost = sizeBoost(sizeMultiplier);
  return {
    pull: round3(base.pull * boost),
    ease: round3(base.ease),
    safe: round3(Math.max(0.11, base.safe / boost)),
    needed: round3(base.needed * boost),
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 大きさの倍率 0.5〜1.5。真ん中がいちばん出やすい山なりにする
 * （一様だと「特大」が当たり前に出てきてありがたみが無い）。
 */
export function rollSizeMultiplier(rng = Math.random) {
  const bell = (rng() + rng() + rng()) / 3;      // 3つ足すと真ん中に寄る
  return Math.round((0.5 + bell) * 100) / 100;
}

/** かかった魚を決める。竿ごとのレア度の出方 → その中から等確率で1種。 */
export function rollFish(rodKey, rng = Math.random) {
  const rod = RODS_BY_KEY.get(rodKey) ?? RODS_BY_KEY.get(DEFAULT_ROD);
  const roll = rng();
  let acc = 0;
  let rarity = 'n';
  for (const key of RARITIES) {
    acc += rod.hit[key];
    if (roll < acc) { rarity = key; break; }
  }
  const pool = FISH.filter((fish) => fish.rarity === rarity);
  return pool[Math.floor(rng() * pool.length)] ?? pool[0];
}

/** 実際の大きさ（cm）。表示用に小数1桁まで。 */
export function actualSize(fish, sizeMultiplier) {
  return Math.round(fish.size * sizeMultiplier * 10) / 10;
}

/** 売値。大きさの倍率がそのまま値段に効く。 */
export function priceOf(fish, sizeMultiplier) {
  return Math.max(1, Math.round(fish.price * sizeMultiplier));
}

/** 大きさの呼び名。図鑑と通知で使う。 */
export function sizeLabel(sizeMultiplier) {
  if (sizeMultiplier >= 1.4) return '特大';
  if (sizeMultiplier >= 1.15) return '大';
  if (sizeMultiplier >= 0.85) return '並';
  if (sizeMultiplier >= 0.6) return '小';
  return '豆';
}

/**
 * 1回投げたときの期待値（コイン）。餌代を引いた後。
 * バランスを変えたときにテストで見張るための計算。
 */
export function expectedPerCast(rodKey) {
  const rod = RODS_BY_KEY.get(rodKey) ?? RODS_BY_KEY.get(DEFAULT_ROD);
  let sum = 0;
  for (const key of RARITIES) {
    const pool = FISH.filter((fish) => fish.rarity === key);
    const averagePrice = pool.reduce((total, fish) => total + fish.price, 0) / pool.length;
    sum += rod.hit[key] * FIGHT[key].landRate * averagePrice;
  }
  return sum - BAIT_PRICE;
}

/** 1時間ぶんの期待値。1時間におよそ 100 回投げる想定。 */
export const CASTS_PER_HOUR = 100;

export function expectedPerHour(rodKey) {
  return Math.round(expectedPerCast(rodKey) * CASTS_PER_HOUR);
}

/** 魚の絵文字名（Developer Portal に上げてある名前）。 */
export function fishSlot(id) {
  return `fish_${id}`;
}
