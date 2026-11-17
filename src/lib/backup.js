/**
 * Bot の設定の書き出し・読み込み（バックアップや、別のサーバーへ写すとき用）。
 *
 * 【入れるもの】通貨・賭け金・1日の区切り・ゲームのオンオフなどの設定と、報告のアクション。
 * 【入れないもの】
 * ・チャンネルの指定：サーバーごとに違うので、写した先では選び直してもらう
 * ・メンバーの残高や記録：個人のデータは書き出さない
 * ・称号と連日ボーナス：それぞれの画面に専用の書き出し・貼り付けがある
 *
 * 読み込みは「足す・上書きする」だけで、書き出しに無いアクションは消さない。
 */
import { GAME_BY_KEY } from './game-catalog.js';
import { cleanLine, cleanText } from './text.js';

export const BACKUP_VERSION = 1;

/** 設定の項目と、読み込むときの決まり。 */
const SETTING_RULES = {
  currency_name: { type: 'text', max: 16 },
  currency_emoji: { type: 'text', max: 8 },
  starting_balance: { type: 'int', min: 0, max: 1_000_000_000 },
  min_bet: { type: 'int', min: 1, max: 1_000_000_000 },
  max_bet: { type: 'int', min: 0, max: 1_000_000_000 },
  disabled_games: { type: 'games' },
  day_start_hour: { type: 'int', min: 0, max: 12, nullable: true },
  solo_private: { type: 'int', min: 0, max: 1 },
  fold_finished: { type: 'int', min: 0, max: 1 },
  live_threshold: { type: 'int', min: 0, max: 1_000_000_000 },
};

export async function exportSettings(db, guildId, settings) {
  const activities = await db.all(
    'SELECT name, emoji, reward, cooldown_sec, daily_limit, description FROM activities WHERE guild_id = ?1 ORDER BY created_at ASC',
    guildId,
  );
  const picked = Object.fromEntries(Object.keys(SETTING_RULES).map((key) => [key, settings[key] ?? null]));
  return JSON.stringify({
    v: BACKUP_VERSION,
    settings: picked,
    activities: activities.map((a) => [a.name, a.emoji ?? '', a.reward, a.cooldown_sec, a.daily_limit, a.description ?? '']),
  });
}

function readSetting(key, value, errors) {
  const rule = SETTING_RULES[key];
  if (!rule) return undefined;
  if (value === null && rule.nullable) return null;
  if (rule.type === 'text') {
    const text = cleanLine(String(value ?? ''), { max: rule.max });
    if (!text) errors.push(`${key} が空です`);
    return text ?? undefined;
  }
  if (rule.type === 'games') {
    const keys = String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => GAME_BY_KEY.has(part));
    return keys.join(',');
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < rule.min || number > rule.max) {
    errors.push(`${key} は ${rule.min}〜${rule.max} の整数にしてください（${value}）`);
    return undefined;
  }
  return number;
}

/**
 * 貼り付けられた文字を読む。DB には触らない。
 * @returns {{settings: object, activities: object[], errors: string[]}}
 */
export function parseBackup(text) {
  const errors = [];
  let data;
  try {
    // コードブロックごと貼られても読めるように、``` を外す
    data = JSON.parse(String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    return { settings: {}, activities: [], errors: ['書き出した文字をそのまま貼ってください（読み取れませんでした）'] };
  }
  if (data?.v !== BACKUP_VERSION) errors.push(`知らない形式です（v=${data?.v}）`);

  const settings = {};
  for (const [key, value] of Object.entries(data?.settings ?? {})) {
    const read = readSetting(key, value, errors);
    if (read !== undefined) settings[key] = read;
  }
  if (settings.max_bet > 0 && settings.min_bet && settings.max_bet < settings.min_bet) {
    errors.push('最高賭け金は最低賭け金以上にしてください');
    delete settings.max_bet;
  }

  const activities = [];
  for (const entry of Array.isArray(data?.activities) ? data.activities.slice(0, 50) : []) {
    const [rawName, emoji, reward, cooldown, limit, description] = Array.isArray(entry) ? entry : [];
    const name = cleanLine(String(rawName ?? ''), { max: 32 });
    const numbers = [reward, cooldown, limit].map(Number);
    if (!name || numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 1_000_000_000)) {
      errors.push(`アクション「${rawName}」は読めなかったので飛ばしました`);
      continue;
    }
    activities.push({
      name,
      emoji: cleanLine(String(emoji ?? ''), { max: 8 }),
      reward: numbers[0],
      cooldown_sec: numbers[1],
      daily_limit: numbers[2],
      description: cleanText(String(description ?? ''), { max: 100 }),
    });
  }
  return { settings, activities, errors };
}
