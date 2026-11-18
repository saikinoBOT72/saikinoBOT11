/**
 * 👤 プロフィール。自分のまとめを見て、ほかの人のも見られる。
 * 本人が「見せない」にしていたら、ほかの人には中身を出さない。
 */
import { isProfileHidden, profileOf, toggleProfileHidden } from '../lib/profile.js';
import { titleTag } from '../lib/achievements.js';
import { coins, truncate } from '../lib/format.js';
import { userSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { backButton, button, embed, homeButton, id, row, shareButton, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  return view(ix, ctx, ix.userId, notice);
}

/** 右クリックの「プロフィールを見る」から。 */
export async function showProfile(ix, ctx, targetId) {
  if (!targetId) return view(ix, ctx, ix.userId);
  if (ix.targetUser?.bot) return view(ix, ctx, ix.userId, 'Bot にはプロフィールがありません。');
  return view(ix, ctx, targetId);
}

export async function pick(ix, _args, ctx) {
  const targetId = ix.values[0];
  if (ix.raw.data?.resolved?.users?.[targetId]?.bot) return view(ix, ctx, ix.userId, 'Bot にはプロフィールがありません。');
  return view(ix, ctx, targetId);
}

export async function hide(ix, _args, ctx) {
  const hidden = await toggleProfileHidden(ctx.db, ix.guildId, ix.userId);
  return view(
    ix,
    ctx,
    ix.userId,
    hidden ? 'プロフィールを「見せない」にしました。ほかの人からは中身が見えません' : 'プロフィールを「見せる」にしました',
  );
}

async function view(ix, ctx, targetId, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const mine = targetId === ix.userId;
  const hidden = await isProfileHidden(ctx.db, ix.guildId, targetId);
  const data = mine || !hidden ? await profileOf(ctx.db, ix.guildId, targetId, ctx.calendar) : null;

  let main;
  if (!mine && hidden) {
    main = embed({ color: 0x95a5a6, title: '👤 プロフィール', description: `<@${targetId}> はプロフィールを見せない設定にしています。` });
  } else if (!data) {
    main = embed({ color: 0x95a5a6, title: '👤 プロフィール', description: `<@${targetId}> はまだこのサーバーで遊んでいません。` });
  } else {
    const tag = titleTag(data.title);
    const titles = data.earned.map((achievement) => achievement.emoji ?? '🏅').join('');
    main = embed({
      color: 0x5865f2,
      author: mine ? { name: ix.displayName, icon_url: ix.avatar } : undefined,
      title: `👤 プロフィール${tag ? `　【${tag}】` : ''}`,
      description: `<@${targetId}>`,
      fields: [
        { name: '所持金', value: `${coins(data.balance, settings)}（${data.rank} 位）`, inline: true },
        { name: '報告', value: `${data.reports} 回`, inline: true },
        { name: '1対1', value: data.wins + data.losses > 0 ? `${data.wins}勝 ${data.losses}敗` : '—', inline: true },
        {
          name: '🔥 続いている連続記録',
          value:
            data.streaks.map((streak) => `**${truncate(streak.activity, 20)}** ${streak.current}日`).join('　') ||
            `いまは無し（最高 ${data.bestStreak} 日）`,
        },
        { name: `🏅 称号（${data.earned.length}）`, value: titles ? truncate(titles, 1024) : 'まだありません' },
      ],
      footer: mine ? { text: hidden ? '🙈 いまはほかの人に見せていません' : '👀 ほかの人もこのプロフィールを見られます' } : undefined,
    });
  }

  return show(ix, {
    embeds: [withNotice(main, notice)],
    components: [
      userSelect(id('profile', 'pick'), 'ほかの人のプロフィールを見る'),
      row(
        mine || targetId === ix.userId
          ? button(id('profile', 'hide'), hidden ? '見せるにする' : '見せないにする', {
              emoji: hidden ? '👀' : '🙈',
              style: ButtonStyle.SECONDARY,
            })
          : button(id('profile', 'open'), '自分のプロフィール', { emoji: '👤' }),
        mine && data ? shareButton() : null,
        backButton('wallet', 'お財布へ'),
        homeButton(),
      ),
    ],
  });
}

export const actions = { open, pick, hide };
