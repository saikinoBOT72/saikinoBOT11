import { getActivity, listActivities, reportGates, reportStats } from '../lib/activities.js';
import { UNDO_WINDOW_MS, announceChannelFor, attemptReport, rememberPost, reportEmbed, undoReport } from '../lib/reporting.js';
import { coins, duration, truncate } from '../lib/format.js';
import { describeDayStart } from '../lib/calendar.js';
import { ButtonStyle } from '../discord/constants.js';
import { stringSelect } from '../discord/builders.js';
import { COLORS, backButton, button, embed, homeButton, id, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const activities = await listActivities(ctx.db, ix.guildId);

  if (activities.length === 0) {
    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: COLORS.earn,
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
  const shown = activities.slice(0, 25);
  const gates = await reportGates(ctx.db, ix.guildId, ix.userId, shown, ctx.calendar);
  for (const activity of shown) {
    const gate = gates.get(activity.name);
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
          color: COLORS.earn,
          title: '💪 報告してかせぐ',
          description: lines.join('\n'),
          footer: { text: [describeDayStart(ctx.calendar), '下のリストから選ぶだけで報告できます'].filter(Boolean).join(' ／ ') },
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
    calendar: ctx.calendar,
  });
  if (!result.ok) return open(ix, [], ctx, result.message);

  await postReport(ix, ctx, activity, result, settings);

  return show(ix, {
    embeds: [
      embed({
        color: COLORS.earn,
        title: `${activity.emoji ?? '✅'} ${activity.name} を報告しました`,
        description: `${coins(activity.reward, settings)} を獲得！\n所持金は ${coins(result.balance, settings)} です。`,
        footer: { text: `みんなに見えるようにチャンネルにも投稿しました。押し間違いなら${UNDO_WINDOW_MS / 60000}分以内に取り消せます` },
      }),
    ],
    components: [
      row(
        button(id('report', 'open'), '続けて報告', { emoji: '💪', style: ButtonStyle.SUCCESS }),
        undoButton(result),
        homeButton(),
      ),
    ],
  });
}

/**
 * 報告をチャンネルに出し、出た場所を控える（取り消したときに消すため）。
 * 転送先が決まっていれば、そちらに出す（決まっていなければこのチャンネル）。
 */
export async function postReport(ix, ctx, activity, result, settings) {
  const channelId = await announceChannelFor(ctx.db, ix.guildId, ix.channelId);
  const posting = ctx.announce(channelId, {
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
  ctx.waitUntil(
    posting
      .then((message) => message && rememberPost(ctx.db, result.logId, channelId, message.id))
      .catch((error) => console.error('報告の投稿先を控えられませんでした:', error)),
  );
}

/** 押し間違いを取り消すボタン（5分以内）。 */
export function undoButton(result) {
  if (!result.logId) return null;
  return button(id('report', 'undo', String(result.logId)), '取り消す', { emoji: '↩️' });
}

/** 報告を取り消す。コインと連続記録を戻し、チャンネルに出た報告も消す。 */
export async function undo(ix, [rawId], ctx) {
  const settings = await ctx.settings(ix.guildId);
  const result = await undoReport(ctx.db, ix.guildId, ix.userId, Number(rawId));
  if (!result.ok) return open(ix, [], ctx, result.message);

  const { log, total } = result;
  if (log.post_channel_id && log.post_message_id) {
    ctx.waitUntil(
      ctx.rest
        .deleteMessage(log.post_channel_id, log.post_message_id)
        .catch((error) => ctx.reportError(ix.guildId, '報告の投稿を消す', error)),
    );
  }
  const back = total > 0 ? `（${coins(total, settings)} を戻しました）` : '';
  return open(ix, [], ctx, { kind: 'ok', text: `「${log.activity}」の報告を取り消しました${back}` });
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
        color: COLORS.earn,
        author: { name: ix.displayName, icon_url: ix.avatar },
        title: '📈 報告の実績',
        description: `報告回数 **${data.total.n}** 回／獲得 ${coins(data.total.sum, settings)}`,
        fields,
      }),
    ],
    components: [row(backButton('report'), homeButton())],
  });
}

export const actions = { open, pick, stats, undo };
