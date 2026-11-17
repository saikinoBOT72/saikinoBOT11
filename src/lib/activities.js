import { startOfToday } from './format.js';

/** よくある報告アクションのプリセット。 */
export const PRESET_ACTIVITIES = [
  { name: '筋トレ', emoji: '💪', reward: 50, cooldown_sec: 21600, daily_limit: 2, description: '筋トレした報告' },
  { name: 'ランニング', emoji: '🏃', reward: 60, cooldown_sec: 21600, daily_limit: 2, description: '走った報告' },
  { name: '勉強', emoji: '📚', reward: 40, cooldown_sec: 10800, daily_limit: 3, description: '勉強した報告' },
  { name: '早起き', emoji: '🌅', reward: 30, cooldown_sec: 0, daily_limit: 1, description: '早起きできた報告' },
  { name: '自炊', emoji: '🍳', reward: 30, cooldown_sec: 0, daily_limit: 3, description: '自炊した報告' },
];

export async function listActivities(db, guildId) {
  return db.all('SELECT * FROM activities WHERE guild_id = ?1 ORDER BY reward DESC, name ASC', guildId);
}

export async function getActivity(db, guildId, name) {
  return db.get('SELECT * FROM activities WHERE guild_id = ?1 AND name = ?2', guildId, name);
}

export async function upsertActivity(db, guildId, activity) {
  const current = await getActivity(db, guildId, activity.name);
  const merged = {
    emoji: activity.emoji ?? current?.emoji ?? null,
    reward: activity.reward ?? current?.reward ?? 0,
    cooldown_sec: activity.cooldown_sec ?? current?.cooldown_sec ?? 0,
    daily_limit: activity.daily_limit ?? current?.daily_limit ?? 0,
    description: activity.description ?? current?.description ?? null,
  };
  await db.run(
    `INSERT INTO activities (guild_id, name, emoji, reward, cooldown_sec, daily_limit, description, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(guild_id, name) DO UPDATE SET
       emoji = excluded.emoji, reward = excluded.reward, cooldown_sec = excluded.cooldown_sec,
       daily_limit = excluded.daily_limit, description = excluded.description`,
    guildId,
    activity.name,
    merged.emoji,
    merged.reward,
    merged.cooldown_sec,
    merged.daily_limit,
    merged.description,
    current?.created_at ?? Date.now(),
  );
  return getActivity(db, guildId, activity.name);
}

/**
 * アクションの名前を変える。
 *
 * 報告の記録・連続記録・連日ボーナス・称号の条件・定期発表は、どれもアクションを
 * 名前で指している。名前だけ変えると、全員の連続記録が切れ、称号も発表も
 * 古い名前を見たままになる。なので全部まとめて新しい名前に付け替える（1つの処理で）。
 * @returns {Promise<{ok: true} | {ok: false, reason: 'missing'|'taken'}>}
 */
export async function renameActivity(db, guildId, from, to) {
  if (from === to) return { ok: true };
  if (!(await getActivity(db, guildId, from))) return { ok: false, reason: 'missing' };
  if (await getActivity(db, guildId, to)) return { ok: false, reason: 'taken' };

  await db.batch([
    ['UPDATE activities SET name = ?3 WHERE guild_id = ?1 AND name = ?2', guildId, from, to],
    ['UPDATE activity_logs SET activity = ?3 WHERE guild_id = ?1 AND activity = ?2', guildId, from, to],
    ['UPDATE streaks SET activity = ?3 WHERE guild_id = ?1 AND activity = ?2', guildId, from, to],
    ['UPDATE streak_rewards SET activity = ?3 WHERE guild_id = ?1 AND activity = ?2', guildId, from, to],
    ['UPDATE achievements SET activity_name = ?3 WHERE guild_id = ?1 AND activity_name = ?2', guildId, from, to],
    ['UPDATE announcements SET activity_name = ?3 WHERE guild_id = ?1 AND activity_name = ?2', guildId, from, to],
    // 報告の履歴の説明（detail）にもアクション名が入っている
    ["UPDATE ledger SET detail = ?3 WHERE guild_id = ?1 AND reason = 'report' AND detail = ?2", guildId, from, to],
  ]);
  return { ok: true };
}

export async function removeActivity(db, guildId, name) {
  const result = await db.run('DELETE FROM activities WHERE guild_id = ?1 AND name = ?2', guildId, name);
  return result.changes > 0;
}

export async function countToday(db, guildId, userId, name, calendar) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at >= ?4',
    guildId,
    userId,
    name,
    startOfToday(calendar),
  );
  return row?.n ?? 0;
}

/**
 * 報告できる状態か判定する。
 * @returns {{ok: true} | {ok: false, reason: 'cooldown', retryAtMs: number} | {ok: false, reason: 'daily', limit: number}}
 */
export async function canReport(db, guildId, userId, activity, calendar) {
  if (activity.daily_limit > 0) {
    const today = await countToday(db, guildId, userId, activity.name, calendar);
    if (today >= activity.daily_limit) return { ok: false, reason: 'daily', limit: activity.daily_limit };
  }
  if (activity.cooldown_sec > 0) {
    const row = await db.get(
      'SELECT MAX(created_at) AS at FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
      guildId,
      userId,
      activity.name,
    );
    if (row?.at) {
      const retryAtMs = row.at + activity.cooldown_sec * 1000;
      if (retryAtMs > Date.now()) return { ok: false, reason: 'cooldown', retryAtMs };
    }
  }
  return { ok: true };
}

/**
 * 報告を確定してコインを渡す。制限に引っかかったら何もせず false。
 *
 * 【同時押しで制限をすり抜けさせない】
 * 「制限を確かめる → 記録する」を別々にやると、同時に2回押されたとき
 * 両方が「まだ大丈夫」と判断して2回とも通ってしまう（1日1回のアクションでも）。
 * そこで履歴・残高・報告の記録を1つの処理にまとめ、どの文にも同じ条件
 * （1日の上限に届いていない・休憩中でない）を付ける。報告の記録を最後に置くので、
 * 条件の真偽は途中で変わらない。2回目の処理は条件が偽になって、何も動かない。
 */
export async function claimReport(db, guildId, userId, activity, calendar, note = null, now = Date.now()) {
  // ?1=サーバー ?2=本人 ?3=アクション ?4=今日の始まり ?5=1日の上限 ?6=休憩(秒) ?7=いま
  const allowed = `
    (?5 <= 0 OR (SELECT COUNT(*) FROM activity_logs
                  WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at >= ?4) < ?5)
    AND (?6 <= 0 OR NOT EXISTS (SELECT 1 FROM activity_logs
                  WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3 AND created_at > ?7 - ?6 * 1000))`;
  const base = [guildId, userId, activity.name, startOfToday(calendar, new Date(now)), activity.daily_limit, activity.cooldown_sec, now];

  const statements = [];
  if (activity.reward > 0) {
    statements.push(
      [
        `INSERT INTO ledger (guild_id, user_id, amount, reason, detail, created_at)
         SELECT ?1, ?2, ?8, 'report', ?3, ?7 WHERE ${allowed}`,
        ...base, activity.reward,
      ],
      [`UPDATE balances SET balance = balance + ?8 WHERE guild_id = ?1 AND user_id = ?2 AND ${allowed}`, ...base, activity.reward],
    );
  }
  statements.push([
    `INSERT INTO activity_logs (guild_id, user_id, activity, reward, note, created_at)
     SELECT ?1, ?2, ?3, ?8, ?9, ?7 WHERE ${allowed}`,
    ...base, activity.reward, note,
  ]);

  const results = await db.batch(statements);
  return results.at(-1).changes === 1;
}

/**
 * 全アクションぶんの「報告できるか」をまとめて調べる。
 * canReport をアクションごとに呼ぶと、画面を1つ出すのに 2×アクション数 回の問い合わせになる。
 * ここでは「今日の回数」と「最後に報告した時刻」を1回ずつ、アクションごとにまとめて引く。
 * @returns {Promise<Map<string, ReturnType<typeof canReport> extends Promise<infer T> ? T : never>>}
 */
export async function reportGates(db, guildId, userId, activities, calendar, now = Date.now()) {
  const [todayRows, lastRows] = await Promise.all([
    db.all(
      `SELECT activity, COUNT(*) AS n FROM activity_logs
        WHERE guild_id = ?1 AND user_id = ?2 AND created_at >= ?3 GROUP BY activity`,
      guildId,
      userId,
      startOfToday(calendar, new Date(now)),
    ),
    db.all(
      'SELECT activity, MAX(created_at) AS at FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 GROUP BY activity',
      guildId,
      userId,
    ),
  ]);
  const today = new Map(todayRows.map((row) => [row.activity, row.n]));
  const last = new Map(lastRows.map((row) => [row.activity, row.at]));

  const gates = new Map();
  for (const activity of activities) {
    const count = today.get(activity.name) ?? 0;
    const at = last.get(activity.name);
    if (activity.daily_limit > 0 && count >= activity.daily_limit) {
      gates.set(activity.name, { ok: false, reason: 'daily', limit: activity.daily_limit, count });
    } else if (activity.cooldown_sec > 0 && at && at + activity.cooldown_sec * 1000 > now) {
      gates.set(activity.name, { ok: false, reason: 'cooldown', retryAtMs: at + activity.cooldown_sec * 1000, count });
    } else {
      gates.set(activity.name, { ok: true, count });
    }
  }
  return gates;
}

export async function logReport(db, guildId, userId, name, reward, note = null) {
  await db.run(
    'INSERT INTO activity_logs (guild_id, user_id, activity, reward, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    guildId,
    userId,
    name,
    reward,
    note,
    Date.now(),
  );
}

export async function reportStats(db, guildId, userId) {
  const total = await db.get(
    'SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2',
    guildId,
    userId,
  );
  const byActivity = await db.all(
    `SELECT activity, COUNT(*) AS n, COALESCE(SUM(reward), 0) AS sum FROM activity_logs
      WHERE guild_id = ?1 AND user_id = ?2 GROUP BY activity ORDER BY n DESC LIMIT 10`,
    guildId,
    userId,
  );
  return { total: total ?? { n: 0, sum: 0 }, byActivity };
}
