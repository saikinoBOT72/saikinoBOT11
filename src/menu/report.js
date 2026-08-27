import { canReport, getActivity, listActivities, reportStats } from '../lib/activities.js';
import { attemptReport, gateMessage, reportEmbed } from '../lib/reporting.js';
import { coins, duration, truncate } from '../lib/format.js';
import { ButtonStyle } from '../discord/constants.js';
import { stringSelect } from '../discord/builders.js';
import { backButton, button, embed, homeButton, id, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const activities = await listActivities(ctx.db, ix.guildId);

  if (activities.length === 0) {
    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: 0x3498db,
            title: '💪 報告してかせぐ',
            description:
              'まだアクションが登録されていません。\nサーバー管理者が **⚙️ 管理 → 📋 アクション管理 → 📦 おすすめを一括登録** すればすぐ始められます。',
          }),
          notice,
        ),
      ],
      components: [row(backButton())],
    });
  }

  const lines = [];
  const options = [];
  for (const activity of activities.slice(0, 25)) {
    const gate = await canReport(ctx.db, ix.guildId, ix.userId, activity, ctx.timezone);
    const limits = [];
    if (activity.cooldown_sec > 0) limits.push(`${duration(activity.cooldown_sec)}おき`);
    if (activity.daily_limit > 0) limits.push(`1日${activity.daily_limit}回`);
    const status = gate.ok ? '' : gate.reason === 'cooldown' ? '　⏳休憩中' : '　✅今日は達成済み';
    lines.push(
      `${activity.emoji ?? '•'} **${activity.name}** ＋${settings.currency_emoji}${activity.reward}` +
        (limits.length > 0 ? `　*(${limits.join(' / ')})*` : '') +
        status,
    );
    options.push({
      label: truncate(`${activity.name}（+${activity.reward}）`, 100),
      value: activity.name,
      emoji: activity.emoji ?? undefined,
      description: truncate(optionHint(activity, gate, limits), 100),
    });
  }

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x2ecc71,
          title: '💪 報告してかせぐ',
          description: lines.join('\n'),
          footer: { text: '下のリストから選ぶだけで報告できます' },
        }),
        notice,
      ),
    ],
    components: [
      stringSelect(id('report', 'pick'), '報告するアクションを選ぶ', options),
      row(backButton(), button(id('report', 'stats'), '実績を見る', { emoji: '📈' })),
    ],
  });
}

function optionHint(activity, gate, limits) {
  if (!gate.ok) return gate.reason === 'cooldown' ? '休憩中' : '今日はもう達成済み';
  if (activity.description) return activity.description;
  return limits.length > 0 ? limits.join(' / ') : '報告できます';
}

export async function pick(ix, _args, ctx) {
  const name = ix.values[0];
  const activity = await getActivity(ctx.db, ix.guildId, name);
  if (!activity) return open(ix, [], ctx, 'そのアクションは削除されたようです。');

  const settings = await ctx.settings(ix.guildId);
  const result = await attemptReport(ctx.db, {
    guildId: ix.guildId,
    userId: ix.userId,
    activity,
    timezone: ctx.timezone,
  });
  if (!result.ok) return open(ix, [], ctx, result.message);

  ctx.announce(ix.channelId, {
    embeds: [
      reportEmbed({
        user: ix.user,
        displayName: ix.displayName,
        avatarUrl: ix.avatar,
        activity,
        result,
        settings,
      }),
    ],
  });

  return show(ix, {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: `${activity.emoji ?? '✅'} ${activity.name} を報告しました`,
        description: `${coins(activity.reward, settings)} を獲得！\n所持金は ${coins(result.balance, settings)} です。`,
        footer: { text: 'みんなに見えるようにチャンネルにも投稿しました' },
      }),
    ],
    components: [
      row(button(id('report', 'open'), '続けて報告', { emoji: '💪', style: ButtonStyle.SUCCESS }), homeButton()),
    ],
  });
}

export async function stats(ix, _args, ctx) {
  const settings = await ctx.settings(ix.guildId);
  const data = await reportStats(ctx.db, ix.guildId, ix.userId);
  const fields =
    data.byActivity.length > 0
      ? [
          {
            name: '内訳',
            value: data.byActivity
              .map((entry) => `• **${entry.activity}** ${entry.n} 回（${settings.currency_emoji} ${entry.sum}）`)
              .join('\n'),
          },
        ]
      : [];

  return show(ix, {
    embeds: [
      embed({
        color: 0x3498db,
        author: { name: ix.displayName, icon_url: ix.avatar },
        title: '📈 報告の実績',
        description: `報告回数 **${data.total.n}** 回／獲得 ${coins(data.total.sum, settings)}`,
        fields,
      }),
    ],
    components: [row(backButton('report'), homeButton())],
  });
}

export const actions = { open, pick, stats };
