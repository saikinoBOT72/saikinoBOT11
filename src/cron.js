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
import { cancelExpired as cancelExpiredDuels, findGame } from './menu/duel-board.js';
import { timeOut as blackjackTimeOut } from './menu/blackjack-table.js';
import { expiredTables } from './lib/blackjack-table.js';
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
import {
  DRAW_HOUR,
  activeLotteries,
  drawLottery,
  formatNumber,
  isDrawTime,
  poolOf,
} from './lib/lottery.js';
import { embed } from './discord/builders.js';
import { EMOJI as em } from './lib/emoji.js';

/** 定期処理の一覧。増えたらここに足す。 */
export const STEPS = [
  sweepExpiredMatches,
  sweepExpiredChinchiro,
  sweepExpiredDuels,
  sweepBlackjack,
  sweepPolls,
  postDueAnnouncements,
  drawLotteries,
];

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
/** 時間切れの1対1ゲーム（ロシアンルーレット・チャージ＆シュートなど）を片付ける。 */
export async function sweepExpiredDuels(ctx) {
  const handled = await cancelExpiredDuels(ctx.db);
  for (const { duel, refunded } of handled) {
    if (!duel.message_id) continue;
    const rules = findGame(duel.game);
    await ctx.rest
      .editMessage(duel.channel_id, duel.message_id, {
        content: '',
        embeds: [
          embed({
            color: 0xe74c3c,
            title: `${rules?.title ?? '勝負'} 中止`,
            description: refunded
              ? '時間切れのため中止しました。賭け金は返しました。'
              : '時間切れのため勝負は流れました。',
          }),
        ],
        components: [],
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れの対戦を ${handled.length} 件片付けました`);
}

/**
 * 時間切れのブラックジャックの卓を片付ける。
 * まだ配る前なら参加費を返し、途中なら残った人をスタンド扱いにして最後まで進める。
 * （返金目当てで放置されないよう、勝負が始まっていたら必ず決着させる）
 */
export async function sweepBlackjack(ctx) {
  const tables = await expiredTables(ctx.db);
  for (const table of tables) {
    try {
      const handled = await blackjackTimeOut(ctx, table);
      if (!handled || !table.message_id) continue;
      await ctx.rest
        .editMessage(table.channel_id, table.message_id, handled.payload)
        .catch((error) => console.error('ブラックジャックの表示更新に失敗:', error));
    } catch (error) {
      console.error(`ブラックジャックの片付けに失敗 (${table.id}):`, error);
    }
  }
  if (tables.length > 0) console.log(`時間切れの卓を ${tables.length} 件片付けました`);
}

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

/** 毎週日曜の夜、宝くじを抽選して発表する。 */
export async function drawLotteries(ctx, now = new Date()) {
  if (!isDrawTime(ctx.calendar, now)) return;

  const drawKey = dateKey(ctx.calendar, now);
  for (const lottery of await activeLotteries(ctx.db)) {
    try {
      const before = await poolOf(ctx.db, lottery.guild_id, drawKey);
      const result = await drawLottery(ctx.db, lottery, drawKey);
      if (!result) continue; // すでに引いてある

      const settings = await ctx.settings(lottery.guild_id);
      await ctx.rest.createMessage(lottery.channel_id, {
        content: result.winnerId ? `<@${result.winnerId}>` : '',
        embeds: [lotteryEmbed(result, before, settings, em)],
        allowed_mentions: { users: result.winnerId ? [result.winnerId] : [] },
      });
    } catch (error) {
      console.error(`宝くじの抽選に失敗 (${lottery.guild_id}):`, error);
    }
  }
}

function lotteryEmbed(result, before, settings, em) {
  const number = formatNumber(result.number);
  if (result.winnerId) {
    return embed({
      color: 0xf1c40f,
      title: `${em.lottery} 宝くじ 当選！`,
      description:
        `# ${number}\n\n` +
        `🎉 **<@${result.winnerId}> が当てました！**\n` +
        `${settings.currency_emoji} **${result.prize.toLocaleString('ja-JP')}** ${settings.currency_name} を総取りです。`,
      fields: [
        { name: '今回の売上', value: `${result.pool.toLocaleString('ja-JP')}（${result.tickets}枚）`, inline: true },
        { name: '持ち越し分', value: `${result.carryover.toLocaleString('ja-JP')}`, inline: true },
      ],
      footer: { text: `次回は来週の日曜 ${DRAW_HOUR}時` },
    });
  }

  const nextPot = result.carryover + result.pool;
  return embed({
    color: 0x16a085,
    title: `${em.lottery} 宝くじ 抽選結果`,
    description:
      `# ${number}\n\n` +
      (result.tickets > 0
        ? '当たった人はいませんでした。売上はまるごと**来週に持ち越し**です。'
        : '今回は1枚も売れませんでした。'),
    fields: [
      { name: '今回の売上', value: `${result.pool.toLocaleString('ja-JP')}（${result.tickets}枚）`, inline: true },
      { name: '来週の賞金', value: `**${nextPot.toLocaleString('ja-JP')}** から`, inline: true },
    ],
    footer: { text: `次回は来週の日曜 ${DRAW_HOUR}時` },
  });
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
