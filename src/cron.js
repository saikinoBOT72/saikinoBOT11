/**
 * 1分ごとの定期処理。
 * 時間切れの勝負を片付け、締切の来た予想大会を締め、時間になった発表を投稿する。
 *
 * ひとつが失敗しても残りは動かしたいので、runScheduled で1件ずつ囲ってある。
 */
import { cancelEmbed } from './menu/rps-challenge.js';
import { embedToV2 } from './discord/components-v2.js';
import { ANYONE } from './lib/open-challenge.js';
import { cancelExpired } from './lib/rps.js';
import { cancelEmbed as chinchiroCancelEmbed } from './menu/chinchiro-match.js';
import { cancelExpired as cancelExpiredChinchiro } from './lib/chinchiro.js';
import { expireDuels, findGame } from './menu/duel-board.js';
import { timeOut as blackjackTimeOut } from './menu/blackjack-table.js';
import { expiredTables } from './lib/blackjack-table.js';
import { timeOut as pokerTimeOut } from './menu/poker-table.js';
import { expiredTables as expiredPokerTables } from './lib/poker-table.js';
import { timeOut as pigTimeOut } from './menu/pig-table.js';
import { expiredTables as expiredPigTables } from './lib/pig-table.js';
import { timeOut as chohanTimeOut } from './menu/chohan-table.js';
import { expiredTables as expiredChohanTables } from './lib/chohan-table.js';
import { timeOut as yachtTimeOut } from './menu/yacht-table.js';
import { expiredTables as expiredYachtTables } from './lib/yacht-table.js';
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
import { foldLater, takeDueFolds } from './lib/guild-prefs.js';
import { claimNewVersion, describeVersion, versionOf } from './lib/version.js';
import { claimNudge, nearDeadline, nudgePayload, sweepNudges } from './lib/nudge.js';
import { stateOf as duelStateOf } from './lib/duel.js';
import { idlePlayers as pokerIdle } from './lib/poker-table.js';
import {
  DRAW_HOUR,
  activeLotteries,
  drawLottery,
  formatNumber,
  isDrawTime,
  missedDraws,
} from './lib/lottery.js';
import { embed } from './discord/builders.js';

/** 定期処理の一覧。増えたらここに足す。 */
export const STEPS = [
  sweepExpiredMatches,
  sweepExpiredChinchiro,
  sweepExpiredDuels,
  sweepBlackjack,
  sweepPoker,
  sweepPig,
  sweepChohan,
  sweepYacht,
  sweepPolls,
  postDueAnnouncements,
  drawLotteries,
  foldFinished,
  announceNewVersion,
  nudgeIdlePlayers,
];

/** その勝負で、いま待たせている人。 */
function waitingIn(kind, row) {
  const ids = (roles) => roles.map((role) => (role === 'challenger' ? row.challenger_id : row.opponent_id));
  if (kind === 'duels') {
    const outcome = findGame(row.game)?.timeoutOutcome?.(row, duelStateOf(row));
    if (outcome?.kind === 'forfeit') return ids([outcome.loser]);
    const state = duelStateOf(row);
    if (state?.choice) return ids(['challenger', 'opponent'].filter((role) => !state.choice[role]));
    return ids(['challenger', 'opponent']);
  }
  if (kind === 'rps_matches') {
    return [!row.challenger_hand && row.challenger_id, !row.opponent_hand && row.opponent_id];
  }
  if (kind === 'chinchiro_matches') return row.turn ? ids([row.turn]) : [];

  const state = (() => {
    try {
      return JSON.parse(row.state);
    } catch {
      return {};
    }
  })();
  if (kind === 'blackjack_tables') return [state.players?.[state.turn]?.userId];
  if (kind === 'poker_tables') return pokerIdle(state).map((player) => player.userId);
  if (kind === 'pig_tables') return [state.players?.[state.turn]?.userId];
  if (kind === 'yacht_tables') return row.bet > 0 ? (state.players ?? []).filter((player) => !player.done).map((player) => player.userId) : [];
  return [];
}

/**
 * 時間切れの1分ほど前に、待たせている人に知らせる。
 * 時間切れは「動かなかった人の負け」なので、気づかないまま負けないように。
 */
export async function nudgeIdlePlayers(ctx, now = Date.now()) {
  const kinds = ['duels', 'rps_matches', 'chinchiro_matches', 'blackjack_tables', 'poker_tables', 'pig_tables', 'yacht_tables'];
  for (const kind of kinds) {
    for (const row of await nearDeadline(ctx.db, kind, now)) {
      if (!row.message_id) continue;
      // だれでも受けられる挑戦状の「相手」はまだいないので、知らせる先から外す
      const waiting = waitingIn(kind, row).filter((userId) => userId && userId !== ANYONE);
      if (waiting.length === 0) continue;
      if (!(await claimNudge(ctx.db, kind, row.id, row.expires_at, now))) continue;
      await ctx.rest
        .createMessage(row.channel_id, nudgePayload(waiting, row.message_id))
        .catch((error) => console.error('時間切れの催促に失敗:', error));
    }
  }
  await sweepNudges(ctx.db, now);
}

/** 新しい版が反映されたら、管理用チャンネルを決めているサーバーに一度だけ知らせる。 */
export async function announceNewVersion(ctx) {
  if (!(await claimNewVersion(ctx.db, ctx.env))) return;
  const { sha, note } = versionOf(ctx.env);
  const guilds = await ctx.db.all('SELECT log_channel_id FROM guild_settings WHERE log_channel_id IS NOT NULL LIMIT 25');
  for (const { log_channel_id: channelId } of guilds) {
    await ctx.rest
      .createMessage(channelId, {
        embeds: [
          embed({
            color: 0x2ecc71,
            title: '🚀 新しい版が反映されました',
            description: `${describeVersion(ctx.env)}${note ? `\n> ${note}` : ''}`,
            footer: { text: sha ? `GitHub のコミット ${sha}` : '' },
          }),
        ],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.error('反映のお知らせに失敗:', error));
  }
}

/** 決着から時間が経った掲示を、結果の1行に畳む（管理メニューで「終わった卓を畳む」をオンにしたとき）。 */
export async function foldFinished(ctx) {
  for (const row of await takeDueFolds(ctx.db)) {
    await ctx.rest
      .editMessage(row.channel_id, row.message_id, {
        content: '',
        embeds: [embed({ color: 0x95a5a6, description: `🧺 ${row.summary}` })],
        components: [],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.error('掲示を畳めませんでした:', error));
  }
}

export async function runScheduled(ctx) {
  for (const step of STEPS) {
    try {
      await step(ctx);
    } catch (error) {
      // 1件こけても、ほかの定期処理は動かす
      console.error(`定期処理 ${step.name} に失敗:`, error);
      await reportToLogChannels(ctx, `定期処理 ${step.name}`, error);
    }
  }
}

/**
 * 定期処理はサーバーをまたいで動くので、どのサーバーのせいか分からない。
 * 管理用チャンネルを決めているサーバーそれぞれに記録する（中身は長い ID を伏せた短い説明だけ）。
 */
async function reportToLogChannels(ctx, place, error) {
  try {
    const guilds = await ctx.db.all('SELECT guild_id FROM guild_settings WHERE log_channel_id IS NOT NULL LIMIT 25');
    for (const { guild_id: guildId } of guilds) await ctx.reportError(guildId, place, error);
  } catch (inner) {
    console.error('エラーの記録に失敗:', inner);
  }
}

/** 時間切れで「動かなかった人の負け」になったときの表示。 */
function forfeitEmbed(title, winnerId, loserId, prize, settings) {
  return embed({
    color: 0xf1c40f,
    title: `⏰ ${title}：時間切れ`,
    description:
      `<@${loserId}> が時間内に動かなかったので、**<@${winnerId}> の勝ち**です。\n` +
      (prize > 0 ? `${settings.currency_emoji} **${prize.toLocaleString('ja-JP')}** を受け取りました。` : ''),
  });
}

export async function sweepExpiredMatches(ctx) {
  const handled = await cancelExpired(ctx.db);
  for (const { match, refunded, winnerId, loserId } of handled) {
    if (!match.message_id) continue;
    const settings = await ctx.settings(match.guild_id);
    await ctx.rest
      .editMessage(match.channel_id, match.message_id, {
        content: '',
        embeds: [
          winnerId
            ? forfeitEmbed('じゃんけん', winnerId, loserId, match.bet * 2, settings)
            : cancelEmbed(refunded ? '時間切れのため中止しました。賭け金は返しました。' : '時間切れのため勝負は流れました。'),
        ],
        components: [],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れのじゃんけんを ${handled.length} 件片付けました`);
}

export async function sweepExpiredChinchiro(ctx) {
  const handled = await cancelExpiredChinchiro(ctx.db);
  for (const { match, refunded, winnerId, loserId, prize } of handled) {
    if (!match.message_id) continue;
    const settings = await ctx.settings(match.guild_id);
    await ctx.rest
      .editMessage(match.channel_id, match.message_id, {
        content: '',
        embeds: [
          winnerId
            ? forfeitEmbed('チンチロ', winnerId, loserId, prize, settings)
            : chinchiroCancelEmbed(
                refunded ? '時間切れのため中止しました。預かった額は返しました。' : '時間切れのため勝負は流れました。',
              ),
        ],
        components: [],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れのチンチロを ${handled.length} 件片付けました`);
}

/**
 * 時間切れの1対1ゲーム（ロシアンルーレット・チャージ＆シュートなど）を片付ける。
 * 始まっていれば「待たせていた人の負け」。誰の負けかは各ゲームが決める。
 */
export async function sweepExpiredDuels(ctx) {
  const handled = await expireDuels(ctx.db);
  for (const { duel, outcome, refunded } of handled) {
    if (!duel.message_id) continue;
    const rules = findGame(duel.game);
    const settings = await ctx.settings(duel.guild_id);
    const title = rules?.title ?? '勝負';

    let shown;
    if (outcome.kind === 'forfeit') {
      const loserId = outcome.loser === 'challenger' ? duel.challenger_id : duel.opponent_id;
      const winnerId = outcome.loser === 'challenger' ? duel.opponent_id : duel.challenger_id;
      shown = forfeitEmbed(title, winnerId, loserId, outcome.pot ?? 0, settings);
    } else if (outcome.kind === 'payout') {
      shown = embed({
        color: 0xf1c40f,
        title: `⏰ ${title}：時間切れ`,
        description:
          'ここで持ち帰ったことにしました。選んでいなかった人は「山分け」として数えています。\n' +
          `<@${duel.challenger_id}> → ${outcome.amounts.challenger.toLocaleString('ja-JP')}\n` +
          `<@${duel.opponent_id}> → ${outcome.amounts.opponent.toLocaleString('ja-JP')}`,
      });
    } else {
      shown = embed({
        color: 0xe74c3c,
        title: `${title} 中止`,
        description: refunded ? '時間切れのため中止しました。賭け金は返しました。' : '時間切れのため勝負は流れました。',
      });
    }

    await ctx.rest
      .editMessage(duel.channel_id, duel.message_id, {
        content: '',
        embeds: [shown],
        components: [],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.error('時間切れメッセージの更新に失敗:', error));
  }
  if (handled.length > 0) console.log(`時間切れの対戦を ${handled.length} 件片付けました`);
}

/** 時間切れの簡ポーカーの卓を片付ける。預かったぶんは全員に返す。 */
export async function sweepPoker(ctx) {
  await sweepTables(ctx, expiredPokerTables, pokerTimeOut, '簡ポーカー');
}

/** 時間切れのピッグの卓を片付ける。預かったぶんは全員に返す。 */
export async function sweepPig(ctx) {
  await sweepTables(ctx, expiredPigTables, pigTimeOut, 'ピッグ');
}

/**
 * 時間切れの丁半の盆を片付ける。
 * コマがそろっていれば開けて配当まで済ませる（張った金を無駄にしない）。
 */
export async function sweepChohan(ctx) {
  await sweepTables(ctx, expiredChohanTables, chohanTimeOut, '丁半');
}

/** 時間切れのヨットの卓を片付ける。預かったぶんは全員に返す。 */
export async function sweepYacht(ctx) {
  await sweepTables(ctx, expiredYachtTables, yachtTimeOut, 'ヨット');
}

/** 時間切れの卓を拾って片付け、掲示を書き換える共通処理。 */
async function sweepTables(ctx, findExpired, handle, label) {
  const tables = await findExpired(ctx.db);
  for (const table of tables) {
    try {
      const handled = await handle(ctx, table);
      if (!handled || !table.message_id) continue;
      await ctx.rest
        .editMessage(table.channel_id, table.message_id, handled.payload)
        .catch((error) => console.error(`${label}の表示更新に失敗:`, error));
      await foldLater(ctx, table, handled.payload, label);
    } catch (error) {
      console.error(`${label}の片付けに失敗 (${table.id}):`, error);
    }
  }
  if (tables.length > 0) console.log(`時間切れの${label}を ${tables.length} 件片付けました`);
}

/**
 * 時間切れのブラックジャックの卓を片付ける。
 * まだ配る前なら参加費を返し、途中なら残った人をスタンド扱いにして最後まで進める。
 * （返金目当てで放置されないよう、勝負が始まっていたら必ず決着させる）
 */
export async function sweepBlackjack(ctx) {
  await sweepTables(ctx, expiredTables, blackjackTimeOut, 'ブラックジャック');
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
  const due = await dueAnnouncements(ctx.db, (guildId) => (guildId ? ctx.calendarFor(guildId) : ctx.calendar));

  for (const announcement of due) {
    // 先に「発表済み」にしてから作る（失敗しても同じ日に二重投稿しない）
    await markAnnounced(ctx.db, announcement.id, announcement.today);
    try {
      const settings = await ctx.settings(announcement.guild_id);
      const built = await buildAnnouncement(ctx.db, announcement, { settings, calendar: announcement.calendar });
      // 対象が誰もいなくても黙って消えないように、一言だけ出す。
      // 同じ時刻に複数の発表を置いたとき「片方だけ出ない」ように見えるのを防ぐ
      const body = built ? built.embed : emptyAnnouncementEmbed(announcement);
      const winners = built?.winners ?? [];
      // 新しい見た目なら Components V2 で出す（送ったきり書き換えないので安全に使える）。
      // 鳴らすのは賞金をもらった人だけ。順位に名前が出ただけの人は鳴らさない
      await ctx.rest.createMessage(
        announcement.channel_id,
        settings.modern_ui ? embedToV2(body, { mentions: winners }) : { embeds: [body], allowed_mentions: { users: winners } },
      );
    } catch (error) {
      console.error(`発表 #${announcement.id} に失敗:`, error);
    }
  }
  if (due.length > 0) console.log(`${due.length} 件の発表を処理しました`);
}

/**
 * 毎週日曜の夜、宝くじを抽選して発表する。
 * あわせて、引きそびれた回（その時間に Bot が止まっていた等）があれば、古い順に追いかけて引く。
 */
export async function drawLotteries(ctx, now = new Date()) {
  const onTime = isDrawTime(ctx.calendar, now);
  const today = dateKey(ctx.calendar, now);

  for (const lottery of await activeLotteries(ctx.db)) {
    const keys = await missedDraws(ctx.db, lottery.guild_id, ctx.calendar, now);
    if (onTime && !keys.includes(today)) keys.push(today);

    for (const drawKey of keys) {
      try {
        const result = await drawLottery(ctx.db, lottery, drawKey);
        if (!result) continue; // すでに引いてある

        const settings = await ctx.settings(lottery.guild_id);
        const late = drawKey !== today || !onTime;
        await ctx.rest.createMessage(lottery.channel_id, {
          content: result.winnerId ? `<@${result.winnerId}>` : '',
          embeds: [lotteryEmbed(result, settings, late ? drawKey : null)],
          allowed_mentions: { users: result.winnerId ? [result.winnerId] : [] },
        });
      } catch (error) {
        console.error('宝くじの抽選に失敗:', error);
      }
    }
  }
}

function lotteryEmbed(result, settings, lateKey = null) {
  const late = lateKey ? `⏰ ${lateKey} の回を、遅れて抽選しました。\n` : '';
  const number = formatNumber(result.number);
  if (result.winnerId) {
    return embed({
      color: 0xf1c40f,
      title: `🎉 ${number} — 当選者あり！`,
      description:
        `${late}# ${number}\n` +
        `**<@${result.winnerId}> が当てました！**\n` +
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
    title: result.tickets > 0 ? `${number} — 当たりなし、来週へ持ち越し` : `${number} — 今回は売れませんでした`,
    description:
      `${late}# ${number}\n` +
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
