/**
 * 管理者向けの「経済の様子」。コインが増えすぎていないか、偏っていないかを見る。
 * 個人を責めるためではなく、報酬や賭け金の設定を見直す材料にする。
 */
import { startOfDay } from './calendar.js';

/** 「報告でもらう」のように、コインが新しく生まれる理由。 */
const MINTED = "reason IN ('report', 'streak', 'achievement', 'ranking', 'initial', 'admin:give') OR reason LIKE '%:bonus'";

export async function economyOverview(db, guildId, calendar, now = Date.now()) {
  const weekAgo = startOfDay(calendar, new Date(now - 6 * 24 * 3600 * 1000));
  const [supply, minted, games, top, daily] = await Promise.all([
    db.get(
      'SELECT COUNT(*) AS accounts, COALESCE(SUM(balance), 0) AS total, COALESCE(MAX(balance), 0) AS richest FROM balances WHERE guild_id = ?1',
      guildId,
    ),
    db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE guild_id = ?1 AND created_at >= ?2 AND (${MINTED})`, guildId, weekAgo),
    // ゲームでの出入りの合計。マイナスなら、そのぶんコインが場から消えている（胴元の取り分）
    db.all(
      `SELECT substr(reason, 1, instr(reason, ':') - 1) AS game, SUM(amount) AS net, COUNT(*) AS n
         FROM ledger
        WHERE guild_id = ?1 AND created_at >= ?2 AND reason LIKE '%:%'
          AND reason NOT LIKE 'shop:%' AND reason NOT LIKE 'admin:%' AND reason NOT LIKE 'tip:%' AND reason NOT LIKE 'report:%'
        GROUP BY game ORDER BY n DESC LIMIT 8`,
      guildId,
      weekAgo,
    ),
    db.all('SELECT balance FROM balances WHERE guild_id = ?1 ORDER BY balance DESC', guildId),
    db.all(
      `SELECT created_at, amount FROM ledger WHERE guild_id = ?1 AND created_at >= ?2 AND (${MINTED})`,
      guildId,
      weekAgo,
    ),
  ]);

  // 上位1割が全体の何％を持っているか（偏りの目安）
  const holders = top.filter((row) => row.balance > 0);
  const tenth = Math.max(1, Math.ceil(holders.length / 10));
  const topShare = supply.total > 0 ? holders.slice(0, tenth).reduce((sum, row) => sum + row.balance, 0) / supply.total : 0;

  // 日ごとに生まれたコイン（古い順に7日）
  const days = Array.from({ length: 7 }, (_, index) => startOfDay(calendar, new Date(now - (6 - index) * 24 * 3600 * 1000)));
  const perDay = days.map((start, index) => {
    const end = days[index + 1] ?? Infinity;
    return daily.filter((row) => row.created_at >= start && row.created_at < end).reduce((sum, row) => sum + row.amount, 0);
  });

  return {
    accounts: supply.accounts,
    total: supply.total,
    richest: supply.richest,
    average: supply.accounts > 0 ? Math.round(supply.total / supply.accounts) : 0,
    mintedWeek: minted.n,
    games,
    topShare,
    perDay,
  };
}

/** 数の並びを ▁▂▃▄▅▆▇█ の棒にする。 */
export function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 0);
  if (max <= 0) return '▁'.repeat(values.length);
  return values.map((value) => bars[Math.min(bars.length - 1, Math.floor((value / max) * (bars.length - 1)))]).join('');
}
