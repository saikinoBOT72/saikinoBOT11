import { winsOf } from './match-results.js';
import { deposit, getBalance } from './economy.js';
import { toWholeNumber } from './format.js';
import { getStreak } from './streak.js';

/** 管理者が選べる達成条件。 */
export const CONDITION_TYPES = {
  activity_count: { label: 'アクションの回数', unit: '回', needsActivity: true },
  activity_streak: { label: 'アクションの連続日数', unit: '日', needsActivity: true },
  total_reports: { label: '報告の合計回数（全アクション）', unit: '回', needsActivity: false },
  balance: { label: '所持金', unit: '', needsActivity: false },
  match_wins: { label: '1対1の勝負で勝った回数', unit: '勝', needsActivity: false },
  games_played: { label: 'ゲームで遊んだ回数', unit: '回', needsActivity: false },
  shop_sales: { label: 'ショップで売れた数', unit: '個', needsActivity: false },
  omikuji_count: { label: 'おみくじを引いた回数', unit: '回', needsActivity: false },
  total_earned: { label: 'これまでに受け取ったコインの合計', unit: '', needsActivity: false },
};

export const CONDITION_EXAMPLES = {
  activity_count: '例: 筋トレを50回で「筋トレ王」',
  activity_streak: '例: 筋トレ30日連続で「鉄の意志」',
  total_reports: '例: 合計100回で「継続の鬼」',
  balance: '例: 所持金10000で「富豪」',
  match_wins: '例: 1対1で10勝して「勝負師」',
  games_played: '例: ゲームを100回遊んで「常連」',
  shop_sales: '例: ショップで10個売れて「名店主」',
  omikuji_count: '例: おみくじ30回で「信心深い」',
  total_earned: '例: 合計50000受け取って「稼ぎ頭」',
};

export function describeCondition(achievement, settings) {
  switch (achievement.condition_type) {
    case 'activity_count':
      return `「${achievement.activity_name}」を ${achievement.threshold} 回`;
    case 'activity_streak':
      return `「${achievement.activity_name}」を ${achievement.threshold} 日連続`;
    case 'total_reports':
      return `報告の合計 ${achievement.threshold} 回`;
    case 'balance':
      return `所持金 ${settings ? settings.currency_emoji : ''}${achievement.threshold} 以上`;
    case 'match_wins':
      return `1対1の勝負で ${achievement.threshold} 勝`;
    case 'games_played':
      return `ゲームで ${achievement.threshold} 回遊ぶ`;
    case 'shop_sales':
      return `ショップで ${achievement.threshold} 個売れる`;
    case 'omikuji_count':
      return `おみくじを ${achievement.threshold} 回引く`;
    case 'total_earned':
      return `これまでに ${settings ? settings.currency_emoji : ''}${achievement.threshold} 受け取る`;
    default:
      return '不明な条件';
  }
}

/** まだ持っていない人に見せる条件。隠し称号は名前も条件も伏せる。 */
export function lockedLabel(achievement, settings) {
  if (achievement.hidden) return { emoji: '❔', name: '？？？', condition: '条件はひみつ' };
  return { emoji: achievement.emoji ?? '🔒', name: achievement.name, condition: describeCondition(achievement, settings) };
}

/* ------------------------------------------------------- コピペで一括設定 */

/**
 * 貼り付け1行の形。DB の列と1対1にしてあるので、書き出したものをそのまま貼り戻せる。
 *
 *   名前 | 絵文字 | 条件 | 数 | 対象アクション | ボーナス
 *   日記魔 | 📔 | activity_count | 100 | 日記を書く | 500
 *   富豪   | 🪙 | balance        | 100000 |          | 10000
 *
 * ・区切りは | か ｜（全角）
 * ・絵文字・対象・ボーナスは空でよい（対象は activity_ 系だけ必須）
 * ・# で始まる行と空行は読み飛ばす
 * ・名前が同じものは上書きされる（createAchievement が upsert なので貼り直し自由）
 */
export const BULK_COLUMNS = '名前 | 絵文字 | 条件 | 数 | 対象アクション | ボーナス | 隠す';

const BULK_SEPARATOR = /[|｜]/;

/**
 * 貼り付けたテキストを1行ずつ読む。DB には触らない。
 * 悪い行は捨てて理由を集める（1行おかしいだけで全部が入らないのは不便なので）。
 * @returns {{entries: object[], errors: {line: number, text: string, reason: string}[]}}
 */
export function parseAchievementLines(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();

  const lines = String(text ?? '').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const columns = trimmed.split(BULK_SEPARATOR).map((column) => column.trim());
    const [name, emoji, type, threshold, activity, reward, hide] = columns;

    if (columns.length < 4) {
      errors.push({ line, text: trimmed, reason: `列が ${columns.length} 個しかありません（${BULK_COLUMNS}）` });
      continue;
    }
    if (!name) {
      errors.push({ line, text: trimmed, reason: '名前が空です' });
      continue;
    }
    if (name.length > 32) {
      errors.push({ line, text: trimmed, reason: `名前が長すぎます（${name.length}文字／32文字まで）` });
      continue;
    }
    if (seen.has(name)) {
      errors.push({ line, text: trimmed, reason: `「${name}」が同じ貼り付けの中で重複しています` });
      continue;
    }
    const meta = CONDITION_TYPES[type];
    if (!meta) {
      errors.push({ line, text: trimmed, reason: `条件 "${type}" は不明です（${Object.keys(CONDITION_TYPES).join(' / ')}）` });
      continue;
    }
    const count = toWholeNumber(threshold);
    if (count === null || count < 1) {
      errors.push({ line, text: trimmed, reason: `数 "${threshold}" は1以上の整数にしてください` });
      continue;
    }
    if (meta.needsActivity && !activity) {
      errors.push({ line, text: trimmed, reason: `${type} は対象アクション名が必要です` });
      continue;
    }
    const bonus = reward ? toWholeNumber(reward) : 0;
    if (bonus === null || bonus < 0) {
      errors.push({ line, text: trimmed, reason: `ボーナス "${reward}" は0以上の整数にしてください` });
      continue;
    }

    seen.add(name);
    entries.push({
      line,
      name,
      emoji: emoji || null,
      condition_type: type,
      threshold: count,
      activity_name: meta.needsActivity ? activity : null,
      reward: bonus,
      hidden: /^(1|隠す|はい|yes|true)$/i.test(hide ?? '') ? 1 : 0,
    });
  }

  return { entries, errors };
}

/** いまの称号を貼り付け形式で書き出す。これをそのまま貼り戻せる。 */
export function formatAchievementLines(achievements) {
  return achievements
    .map((achievement) =>
      [
        achievement.name,
        achievement.emoji ?? '',
        achievement.condition_type,
        achievement.threshold,
        achievement.activity_name ?? '',
        achievement.reward || 0,
        achievement.hidden ? '隠す' : '',
      ]
        .join(' | ')
        .replace(/ \| $/, ''),
    )
    .join('\n');
}

export async function listAchievements(db, guildId) {
  return db.all('SELECT * FROM achievements WHERE guild_id = ?1 ORDER BY threshold ASC, id ASC', guildId);
}


export async function createAchievement(db, guildId, achievement) {
  await db.run(
    `INSERT INTO achievements (guild_id, name, emoji, description, condition_type, threshold, activity_name, reward, created_at, hidden)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(guild_id, name) DO UPDATE SET
       emoji = excluded.emoji, description = excluded.description, condition_type = excluded.condition_type,
       threshold = excluded.threshold, activity_name = excluded.activity_name, reward = excluded.reward,
       hidden = excluded.hidden`,
    guildId,
    achievement.name,
    achievement.emoji ?? null,
    achievement.description ?? null,
    achievement.condition_type,
    achievement.threshold,
    achievement.activity_name ?? null,
    achievement.reward ?? 0,
    Date.now(),
    achievement.hidden ? 1 : 0,
  );
  return db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND name = ?2', guildId, achievement.name);
}

/** 隠し称号にする／戻す。 */
export async function toggleHidden(db, guildId, id) {
  await db.run('UPDATE achievements SET hidden = 1 - hidden WHERE guild_id = ?1 AND id = ?2', guildId, id);
  return db.get('SELECT * FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
}

export async function removeAchievement(db, guildId, id) {
  const result = await db.run('DELETE FROM achievements WHERE guild_id = ?1 AND id = ?2', guildId, id);
  await db.batch([
    ['DELETE FROM user_achievements WHERE guild_id = ?1 AND achievement_id = ?2', guildId, id],
    ['UPDATE profiles SET title_id = NULL WHERE guild_id = ?1 AND title_id = ?2', guildId, id],
  ]);
  return result.changes > 0;
}

export async function earnedBy(db, guildId, userId) {
  return db.all(
    `SELECT a.*, u.earned_at FROM user_achievements u
       JOIN achievements a ON a.id = u.achievement_id
      WHERE u.guild_id = ?1 AND u.user_id = ?2
      ORDER BY u.earned_at DESC`,
    guildId,
    userId,
  );
}

/* ------------------------------------------------------------------ 装備している称号 */

/** 名前の横に出す称号。未設定なら null。 */
export async function equippedTitle(db, guildId, userId) {
  return db.get(
    `SELECT a.* FROM profiles p JOIN achievements a ON a.id = p.title_id
      WHERE p.guild_id = ?1 AND p.user_id = ?2`,
    guildId,
    userId,
  );
}

/** ランキング用にまとめて引く。 @returns {Promise<Map<string, object>>} */
export async function equippedTitles(db, guildId, userIds) {
  if (userIds.length === 0) return new Map();
  const placeholders = userIds.map((_, index) => `?${index + 2}`).join(', ');
  const rows = await db.all(
    `SELECT p.user_id, a.name, a.emoji FROM profiles p JOIN achievements a ON a.id = p.title_id
      WHERE p.guild_id = ?1 AND p.user_id IN (${placeholders})`,
    guildId,
    ...userIds,
  );
  return new Map(rows.map((row) => [row.user_id, row]));
}

/** 称号を装備する（titleId が null なら外す）。持っていない称号は装備できない。 */
export async function equipTitle(db, guildId, userId, titleId) {
  if (titleId !== null) {
    const owned = await db.get(
      'SELECT 1 AS ok FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2 AND achievement_id = ?3',
      guildId,
      userId,
      titleId,
    );
    if (!owned) return false;
  }
  await db.run(
    `INSERT INTO profiles (guild_id, user_id, title_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET title_id = excluded.title_id`,
    guildId,
    userId,
    titleId,
  );
  return true;
}

/** 「🏅筋トレ王」のような表示用の飾り。装備していなければ空文字。 */
export function titleTag(title) {
  if (!title) return '';
  return `${title.emoji ?? '🏅'}${title.name}`;
}

/* ------------------------------------------------------------------ 判定 */

async function collectStats(db, { guildId, userId, calendar }, pending) {
  const types = new Set(pending.map((achievement) => achievement.condition_type));
  const stats = { counts: new Map(), streaks: new Map() };

  if (types.has('total_reports')) {
    const row = await db.get('SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
    stats.totalReports = row?.n ?? 0;
  }
  if (types.has('balance')) {
    stats.balance = await getBalance(db, guildId, userId);
  }
  if (types.has('match_wins')) stats.matchWins = await winsOf(db, guildId, userId);
  if (types.has('games_played')) {
    // 賭けた・参加費を払った回数（ショップ・送金・管理者の調整・報告の取り消しは数えない）
    const row = await db.get(
      `SELECT COUNT(*) AS n FROM ledger
        WHERE guild_id = ?1 AND user_id = ?2 AND amount < 0 AND reason LIKE '%:%'
          AND reason NOT LIKE 'shop:%' AND reason NOT LIKE 'admin:%' AND reason NOT LIKE 'report:%'
          AND reason NOT LIKE 'tip:%' AND reason NOT LIKE 'poll:bonus%'`,
      guildId,
      userId,
    );
    stats.gamesPlayed = row?.n ?? 0;
  }
  if (types.has('shop_sales')) {
    const row = await db.get('SELECT COUNT(*) AS n FROM purchases WHERE guild_id = ?1 AND seller_id = ?2', guildId, userId);
    stats.shopSales = row?.n ?? 0;
  }
  if (types.has('omikuji_count')) {
    const row = await db.get('SELECT COUNT(*) AS n FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
    stats.omikuji = row?.n ?? 0;
  }
  if (types.has('total_earned')) {
    // 受け取った合計。返金・払い戻しのように「自分のお金が戻っただけ」のものは数えない
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM ledger
        WHERE guild_id = ?1 AND user_id = ?2 AND amount > 0
          AND reason NOT LIKE '%:refund' AND reason NOT IN ('initial', 'admin:set')`,
      guildId,
      userId,
    );
    stats.totalEarned = row?.n ?? 0;
  }
  for (const achievement of pending) {
    const name = achievement.activity_name;
    if (!name) continue;
    if (achievement.condition_type === 'activity_count' && !stats.counts.has(name)) {
      const row = await db.get(
        'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
        guildId,
        userId,
        name,
      );
      stats.counts.set(name, row?.n ?? 0);
    }
    if (achievement.condition_type === 'activity_streak' && !stats.streaks.has(name)) {
      stats.streaks.set(name, (await getStreak(db, guildId, userId, name, calendar)).best);
    }
  }
  return stats;
}

function meets(achievement, stats) {
  switch (achievement.condition_type) {
    case 'activity_count':
      return (stats.counts.get(achievement.activity_name) ?? 0) >= achievement.threshold;
    case 'activity_streak':
      return (stats.streaks.get(achievement.activity_name) ?? 0) >= achievement.threshold;
    case 'total_reports':
      return (stats.totalReports ?? 0) >= achievement.threshold;
    case 'balance':
      return (stats.balance ?? 0) >= achievement.threshold;
    case 'match_wins':
      return (stats.matchWins ?? 0) >= achievement.threshold;
    case 'games_played':
      return (stats.gamesPlayed ?? 0) >= achievement.threshold;
    case 'shop_sales':
      return (stats.shopSales ?? 0) >= achievement.threshold;
    case 'omikuji_count':
      return (stats.omikuji ?? 0) >= achievement.threshold;
    case 'total_earned':
      return (stats.totalEarned ?? 0) >= achievement.threshold;
    default:
      return false;
  }
}

/**
 * まだ持っていない称号の条件を満たしたか調べ、満たしていれば付与する。
 * @returns {Promise<Array<object>>} 新しく獲得した称号
 */
export async function evaluate(db, { guildId, userId, calendar }) {
  const all = await listAchievements(db, guildId);
  if (all.length === 0) return [];

  const owned = await db.all('SELECT achievement_id FROM user_achievements WHERE guild_id = ?1 AND user_id = ?2', guildId, userId);
  const ownedIds = new Set(owned.map((row) => row.achievement_id));
  const pending = all.filter((achievement) => !ownedIds.has(achievement.id));
  if (pending.length === 0) return [];

  const stats = await collectStats(db, { guildId, userId, calendar }, pending);
  const unlocked = [];

  for (const achievement of pending) {
    if (!meets(achievement, stats)) continue;
    const claimed = await db.run(
      'INSERT OR IGNORE INTO user_achievements (guild_id, user_id, achievement_id, earned_at) VALUES (?1, ?2, ?3, ?4)',
      guildId,
      userId,
      achievement.id,
      Date.now(),
    );
    if (claimed.changes !== 1) continue;
    if (achievement.reward > 0) await deposit(db, guildId, userId, achievement.reward, 'achievement', achievement.name);
    unlocked.push(achievement);
  }
  return unlocked;
}
