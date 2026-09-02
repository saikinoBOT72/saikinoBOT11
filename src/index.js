import { InteractionType } from './discord/constants.js';
import { verifyRequest } from './discord/verify.js';
import { Ix } from './discord/interaction.js';
import { json, pong, reply } from './discord/respond.js';
import { createContext } from './context.js';
import { handleComponent as handleMenu } from './menu/router.js';
import { handleComponent as handleRps, cancelEmbed } from './menu/rps-challenge.js';
import {
  handleComponent as handleChinchiro,
  cancelEmbed as chinchiroCancelEmbed,
} from './menu/chinchiro-match.js';
import { cancelExpired as cancelExpiredChinchiro } from './lib/chinchiro.js';
import {
  handleComponent as handlePoll,
  boardPayload,
  cancelledPayload as pollCancelledPayload,
} from './menu/poll-board.js';
import {
  abandonedPolls,
  cancelPoll,
  closePoll,
  duePolls,
  getPollById,
  staleOpenPolls,
} from './lib/polls.js';
import { findCommand } from './commands.js';
import { cancelExpired } from './lib/rps.js';
import { buildAnnouncement, dueAnnouncements, markAnnounced } from './lib/announcements.js';
import { dateKey } from './lib/streak.js';

export default {
  /** Discord からの Interaction を受け取る入口。 */
  async fetch(request, env, executionCtx) {
    if (request.method === 'GET') {
      return new Response('saikinoBOT11 は動いています。', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const { valid, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('署名を確認できませんでした。', { status: 401 });

    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Discord からの疎通確認
    if (raw.type === InteractionType.PING) return pong();

    const ix = new Ix(raw);
    const ctx = createContext(env, executionCtx);

    try {
      return await dispatch(ix, ctx);
    } catch (error) {
      console.error('処理中のエラー:', error);
      return reply({ content: '処理中にエラーが発生しました。もう一度お試しください。' });
    }
  },

  /** 1分ごとに走る。時間切れのじゃんけんを片付け、時間になった発表を投稿する。 */
  async scheduled(_event, env, executionCtx) {
    const ctx = createContext(env, executionCtx);
    await sweepExpiredMatches(ctx);
    await sweepExpiredChinchiro(ctx);
    await sweepPolls(ctx);
    await postDueAnnouncements(ctx);
  },
};

async function sweepExpiredMatches(ctx) {
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

async function sweepExpiredChinchiro(ctx) {
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
async function sweepPolls(ctx) {
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

async function postDueAnnouncements(ctx) {
  const due = await dueAnnouncements(ctx.db, ctx.calendar);
  const today = dateKey(ctx.calendar);

  for (const announcement of due) {
    // 先に「発表済み」にしてから作る（失敗しても同じ日に二重投稿しない）
    await markAnnounced(ctx.db, announcement.id, today);
    try {
      const settings = await ctx.settings(announcement.guild_id);
      const built = await buildAnnouncement(ctx.db, announcement, { settings, calendar: ctx.calendar });
      if (!built) continue;
      await ctx.rest.createMessage(announcement.channel_id, {
        embeds: [built.embed],
        allowed_mentions: { users: built.winners },
      });
    } catch (error) {
      console.error(`発表 #${announcement.id} に失敗:`, error);
    }
  }
  if (due.length > 0) console.log(`${due.length} 件の発表を処理しました`);
}

async function dispatch(ix, ctx) {
  if (!ix.guildId) return reply({ content: 'このBotはサーバー内でのみ使えます。' });

  if (ix.type === InteractionType.APPLICATION_COMMAND) {
    const command = findCommand(ix.commandName);
    if (!command) return reply({ content: '知らないコマンドです。' });
    return command(ix, ctx);
  }

  if (ix.type === InteractionType.MESSAGE_COMPONENT || ix.type === InteractionType.MODAL_SUBMIT) {
    const [namespace] = ix.customId.split(':');
    if (namespace === 'm') return handleMenu(ix, ctx);
    if (namespace === 'rps') return handleRps(ix, ctx);
    if (namespace === 'cc') return handleChinchiro(ix, ctx);
    if (namespace === 'pl') return handlePoll(ix, ctx);
    return reply({ content: 'この操作はもう使えません。`/menu` を開き直してください。' });
  }

  return json({ type: 1 });
}
