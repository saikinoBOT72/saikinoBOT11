import { describeCondition, earnedBy, equipTitle, equippedTitle, evaluate, listAchievements, titleTag } from '../lib/achievements.js';
import { allStreaks, listStreakRewards } from '../lib/streak.js';
import { coins, truncate } from '../lib/format.js';
import { stringSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { backButton, button, embed, homeButton, id, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  // 画面を開いたときにも条件を見直す（報告以外で満たした場合の拾い上げ）
  const justUnlocked = await evaluate(ctx.db, { guildId: ix.guildId, userId: ix.userId, timezone: ctx.timezone });

  const [all, earned, streaks, rewards, equipped] = await Promise.all([
    listAchievements(ctx.db, ix.guildId),
    earnedBy(ctx.db, ix.guildId, ix.userId),
    allStreaks(ctx.db, ix.guildId, ix.userId, ctx.timezone),
    listStreakRewards(ctx.db, ix.guildId),
    equippedTitle(ctx.db, ix.guildId, ix.userId),
  ]);

  const earnedIds = new Set(earned.map((achievement) => achievement.id));
  const locked = all.filter((achievement) => !earnedIds.has(achievement.id));
  const alive = streaks.filter((streak) => streak.current > 0);

  const fields = [];
  fields.push({
    name: '🔥 連続記録',
    value:
      alive.length === 0
        ? 'まだ連続していません。今日から始めましょう。'
        : truncate(
            alive
              .map((streak) => {
                const bonus = bonusLine(rewards, streak.activity, streak.current, settings);
                return `**${streak.activity}** 🔥 ${streak.current} 日（最高 ${streak.best} 日）${bonus}`;
              })
              .join('\n'),
            1024,
          ),
  });

  if (earned.length > 0) {
    fields.push({
      name: `🏅 獲得した称号（${earned.length}）`,
      value: truncate(
        earned
          .map((achievement) => {
            const mark = equipped?.id === achievement.id ? '　← 表示中' : '';
            return `${achievement.emoji ?? '🏅'} **${achievement.name}**${mark}`;
          })
          .join('\n'),
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

  const components = [];
  if (earned.length > 0) {
    components.push(
      stringSelect(
        id('titles', 'equip'),
        '名前の横に出す称号を選ぶ',
        [
          { label: '表示しない', value: 'none', description: '称号を外します' },
          ...earned.map((achievement) => ({
            label: truncate(achievement.name, 100),
            value: String(achievement.id),
            emoji: achievement.emoji ?? undefined,
            description: truncate(describeCondition(achievement, settings), 100),
          })),
        ],
      ),
    );
  }
  components.push(row(backButton('wallet'), homeButton()));

  const unlockedNote =
    justUnlocked.length > 0
      ? `🎉 ${justUnlocked.map((achievement) => `**${achievement.name}**`).join('、')} を獲得しました！`
      : notice;

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf39c12,
          author: { name: `${equipped ? `【${titleTag(equipped)}】` : ''}${ix.displayName}`, icon_url: ix.avatar },
          title: '🏅 称号と連続記録',
          description: equipped
            ? `いま表示している称号: **${titleTag(equipped)}**`
            : '称号を獲得すると、名前の横に表示できるようになります。',
          fields,
        }),
        unlockedNote,
      ),
    ],
    components,
  });
}

export async function equip(ix, _args, ctx) {
  const value = ix.values[0];
  if (value === 'none') {
    await equipTitle(ctx.db, ix.guildId, ix.userId, null);
    return open(ix, [], ctx, '称号の表示をやめました');
  }
  const ok = await equipTitle(ctx.db, ix.guildId, ix.userId, Number(value));
  return open(ix, [], ctx, ok ? '表示する称号を変えました' : 'その称号はまだ持っていません');
}

/** いま毎日もらえている額と、次の段階までの日数。 */
function bonusLine(rewards, activity, current, settings) {
  const own = rewards.filter((reward) => reward.activity === activity);
  const now = own
    .filter((reward) => reward.from_days <= current && (reward.to_days === 0 || current <= reward.to_days))
    .sort((a, b) => b.from_days - a.from_days)[0];
  const next = own.filter((reward) => reward.from_days > current).sort((a, b) => a.from_days - b.from_days)[0];

  const parts = [];
  if (now) parts.push(`毎日 ${coins(now.reward, settings)}`);
  if (next) parts.push(`あと ${next.from_days - current} 日で毎日 ${coins(next.reward, settings)}`);
  return parts.length > 0 ? `　→ ${parts.join('／')}` : '';
}

export const actions = { open, equip };
