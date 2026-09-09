/**
 * 1分ごとの定期処理。
 * 時間切れの勝負を片付け、締切の来た予想大会を締め、時間になった発表を投稿する。
 *
 * ひとつが失敗しても残りは動かしたいので、runScheduled で1件ずつ囲ってある。
 */
import { cancelEmbed } from './menu/rps-challenge.js';
import { cancelExpired } from './lib/rps.js';
import { cancelEmbed as chinchiroCancelEmbed } from './menu/chinchiro-match.js';
import { cancelExpired as cancelExpiredChinchiro } from './lib/chinchiro.js';
import { boardPayload, cancelledPayload as pollCancelledPayload } from './menu/poll-board.js';
import {
  abandonedPolls,
  cancelPoll,
  closePoll,
  duePolls,
  getPollById,
  staleOpenPolls,
} from './lib/polls.js';
import { buildAnnouncement, describeSchedule, dueAnnouncements, markAnnounced } from './lib/announcements.js';
import { rankingTitle } from './lib/ranking.js';
import { dateKey } from './lib/calendar.js';
import { embed } from './discord/builders.js';

/** 定期処理の一覧。増えたらここに足す。 */
export const STEPS = [sweepExpiredMatches, sweepExpiredChinchiro, sweepPolls, postDueAnnouncements];

export async function runScheduled(ctx) {
  for (const step of STEPS) {
    try {
      await step(ctx);
    } catch (error) {
      // 1件こけても、ほかの定期処理は動かす
      console.error(`定期処理 ${step.name} に失敗:`, error);
    }
  }
}

export async function sweepExpiredMatches(ctx) {
  const handled = await cancelExpired(ctx.db);
  for (const { match, refunded } of handled) {
    if (!match.message_id) continue;
    await ctx.rest
      .editMessage(match.channel_id, match.message_id, {
        content: '',
        embeds: [cancelEmbed(refunded ? '時間切れのため中止しました。賭け金は返しました。' : '時間切れのため勝負は流れました。')],
        components: [],
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れのじゃんけんを ${handled.length} 件片付けました`);
}

export async function sweepExpiredChinchiro(ctx) {
  const handled = await cancelExpiredChinchiro(ctx.db);
  for (const { match, refunded } of handled) {
    if (!match.message_id) continue;
    await ctx.rest
      .editMessage(match.channel_id, match.message_id, {
        content: '',
        embeds: [
          chinchiroCancelEmbed(
            refunded ? '時間切れのため中止しました。預かった額は返しました。' : '時間切れのため勝負は流れました。',
          ),
        ],
        components: [],
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れのチンチロを ${handled.length} 件片付けました`);
}

/** 締切が来た予想大会を締め、放置されたものは返金して片付ける。 */
export async function sweepPolls(ctx) {
  for (const poll of await duePolls(ctx.db)) {
    if (!(await closePoll(ctx.db, poll.id))) continue;
    if (!poll.message_id) continue;
    const settings = await ctx.settings(poll.guild_id);
    const fresh = await getPollById(ctx.db, poll.id);
    await ctx.rest
      .editMessage(poll.channel_id, poll.message_id, await boardPayload(ctx.db, fresh, settings))
      .catch((error) => console.error('予想大会の締切表示に失敗:', error));
  }

  for (const poll of await staleOpenPolls(ctx.db)) {
    if (!(await cancelPoll(ctx.db, poll))) continue;
    if (!poll.message_id) continue;
    await ctx.rest
      .editMessage(
        poll.channel_id,
        poll.message_id,
        pollCancelledPayload(poll, '締切なしのまま1か月が経ったので、賭けた額は全員に返しました。'),
      )
      .catch((error) => console.error('予想大会の取り消し表示に失敗:', error));
  }

  for (const poll of await abandonedPolls(ctx.db)) {
    if (!(await cancelPoll(ctx.db, poll))) continue;
    if (!poll.message_id) continue;
    await ctx.rest
      .editMessage(
        poll.channel_id,
        poll.message_id,
        pollCancelledPayload(
          poll,
          '正解が決まらないまま日が経ったので、賭けた額は全員に返しました。' +
            (poll.bonus > 0 ? '出題者の上乗せも戻しました。' : ''),
        ),
      )
      .catch((error) => console.error('予想大会の取り消し表示に失敗:', error));
  }
}

export async function postDueAnnouncements(ctx) {
  const due = await dueAnnouncements(ctx.db, ctx.calendar);
  const today = dateKey(ctx.calendar);

  for (const announcement of due) {
    // 先に「発表済み」にしてから作る（失敗しても同じ日に二重投稿しない）
    await markAnnounced(ctx.db, announcement.id, today);
    try {
      const settings = await ctx.settings(announcement.guild_id);
      const built = await buildAnnouncement(ctx.db, announcement, { settings, calendar: ctx.calendar });
      // 対象が誰もいなくても黙って消えないように、一言だけ出す。
      // 同じ時刻に複数の発表を置いたとき「片方だけ出ない」ように見えるのを防ぐ
      await ctx.rest.createMessage(announcement.channel_id, {
        embeds: [built ? built.embed : emptyAnnouncementEmbed(announcement)],
        allowed_mentions: { users: built?.winners ?? [] },
      });
    } catch (error) {
      console.error(`発表 #${announcement.id} に失敗:`, error);
    }
  }
  if (due.length > 0) console.log(`${due.length} 件の発表を処理しました`);
}

function emptyAnnouncementEmbed(announcement) {
  return embed({
    color: 0x95a5a6,
    title: `📢 ${rankingTitle({
      metric: announcement.metric,
      activityName: announcement.activity_name,
      period: announcement.frequency === 'weekly' ? 'week' : 'day',
    })}`,
    description: '今回は対象になる人がいませんでした。',
    footer: { text: describeSchedule(announcement) },
  });
}
