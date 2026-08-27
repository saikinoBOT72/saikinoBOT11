import { CONDITION_TYPES, describeCondition, earnedBy, evaluate, listAchievements } from '../lib/achievements.js';
import { getStreak, listStreakRewards } from '../lib/streak.js';
import { coins, truncate } from '../lib/format.js';
import { backButton, embed, homeButton, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  // 画面を開いたときにも条件を見直す（報告以外で条件を満たした場合の拾い上げ）
  const justUnlocked = await evaluate(ctx.db, {
    guildId: ix.guildId,
    userId: ix.userId,
    timezone: ctx.timezone,
  });

  const [all, earned, streak, rewards] = await Promise.all([
    listAchievements(ctx.db, ix.guildId),
    earnedBy(ctx.db, ix.guildId, ix.userId),
    getStreak(ctx.db, ix.guildId, ix.userId, ctx.timezone),
    listStreakRewards(ctx.db, ix.guildId),
  ]);

  const earnedIds = new Set(earned.map((achievement) => achievement.id));
  const locked = all.filter((achievement) => !earnedIds.has(achievement.id));

  const fields = [];
  fields.push({
    name: '🔥 連続報告',
    value:
      (streak.current > 0 ? `いま **${streak.current}** 日連続` : 'まだ連続していません') +
      `（最高 ${streak.best} 日）` +
      (rewards.length > 0 ? `\n次のボーナス: ${nextBonus(rewards, streak.current, settings)}` : ''),
  });

  if (earned.length > 0) {
    fields.push({
      name: `🏅 獲得した称号（${earned.length}）`,
      value: truncate(
        earned.map((achievement) => `${achievement.emoji ?? '🏅'} **${achievement.name}**`).join('\n'),
        1024,
      ),
    });
  }
  if (locked.length > 0) {
    fields.push({
      name: '🔒 まだの称号',
      value: truncate(
        locked
          .map((achievement) => `${achievement.emoji ?? '🔒'} **${achievement.name}** — ${describeCondition(achievement, settings)}`)
          .join('\n'),
        1024,
      ),
    });
  }
  if (all.length === 0) {
    fields.push({ name: '🏅 称号', value: 'まだ称号が作られていません。管理者が **⚙️ 管理 → 🏅 称号** から作れます。' });
  }

  const unlockedNote =
    justUnlocked.length > 0
      ? `🎉 ${justUnlocked.map((achievement) => `**${achievement.name}**`).join('、')} を獲得しました！`
      : notice;

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf39c12,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: '🏅 称号と連続記録',
          fields,
        }),
        unlockedNote,
      ),
    ],
    components: [row(backButton('wallet'), homeButton())],
  });
}

function nextBonus(rewards, current, settings) {
  const next = rewards.find((reward) => reward.days > current);
  if (!next) return 'すべて達成済み';
  return `**${next.days}日** で ${coins(next.reward, settings)}（あと ${next.days - current} 日）`;
}

export const actions = { open };
export { CONDITION_TYPES };
