/**
 * 丁半博打の、チャンネルに出る公開メッセージ。
 *
 * 【卓と違うところ】
 * 席が無い。盆を開いたら誰でも丁か半にコマを張れる。
 * ボタン1回で一口（table.bet）。何度でも足せるが、途中で反対側へは移れない。
 *
 * 【進み方】
 *   joining → コマを張る時間（3分）
 *   done    → 壺を開けて配当。片方にコマが無ければ不成立で全額返す
 */
import {
  CHO,
  HAN,
  betOf,
  createTable,
  getTable,
  openPot,
  placeBet,
  ready,
  refundTable,
  setMessageId,
  setStatus,
  stateOf,
  totalOn,
} from '../lib/chohan-table.js';
import { SIDES } from '../lib/chohan.js';
import { getSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { diceFaces } from '../lib/emoji.js';

/** 公開メッセージのボタンは `ch:` 始まり。 */
export const namespace = 'ch';

const COLOR = 0x8e44ad;

/* ------------------------------------------------------------------ 盆を開く */

export async function openBoard(ctx, { guildId, channelId, hostId, bet, settings }) {
  const id = crypto.randomUUID();
  await createTable(ctx.db, { id, guildId, channelId, hostId, bet });

  try {
    const table = await getTable(ctx.db, id);
    const message = await ctx.rest.createMessage(channelId, boardPayload(table, stateOf(table), settings));
    await setMessageId(ctx.db, id, message.id);
    return { ok: true, message };
  } catch (error) {
    console.error('丁半の盆の投稿に失敗:', error);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }
}

/* ------------------------------------------------------------------ 振り分け */

export async function handleComponent(ix, ctx) {
  const [, action, id, arg] = ix.customId.split(':');
  const table = await getTable(ctx.db, id);

  if (action === 'again') {
    if (!table) return reply({ content: 'この盆の記録が見つかりませんでした。' });
    return handleAgain(ix, ctx, table);
  }
  if (!table || table.status === 'done' || table.status === 'cancelled') {
    return reply({ content: 'この勝負はもう終わっています。' });
  }

  const settings = await getSettings(ctx.db, table.guild_id);
  if (action === 'bet') return handleBet(ix, ctx, table, arg, settings);
  if (action === 'open') return handleOpen(ix, ctx, table, settings, await ctx.emoji());
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 張る */

async function handleBet(ix, ctx, table, side, settings) {
  if (side !== CHO && side !== HAN) return reply({ content: '不明な操作です。' });

  const placed = await placeBet(ctx.db, table, ix.userId, side);
  if (!placed.ok) {
    const messages = {
      opened: 'もう壺が開いています。',
      otherside: '一度張った側から反対側へは移れません。',
      insufficient: `一口 ${coins(table.bet, settings)} が払えません。`,
    };
    return reply({ content: messages[placed.reason] ?? '張れませんでした。' });
  }

  const fresh = await getTable(ctx.db, table.id);
  const mine = betOf(placed.state.bets, ix.userId);
  ctx.waitUntil(refreshBoard(ctx, fresh, settings));
  return reply({
    content: `${SIDES[side].emoji} **${SIDES[side].label}** に ${coins(table.bet, settings)} 張りました（あなたの合計 ${coins(mine.amount, settings)}）。`,
  });
}

/* ------------------------------------------------------------------ 開ける */

async function handleOpen(ix, ctx, table, settings, em) {
  if (ix.userId !== table.host_id) return reply({ content: '壺を開けられるのは盆を開いた人だけです。' });

  const opened = await openPot(ctx.db, table);
  if (opened.kind === 'late') return reply({ content: 'もう開いています。' });

  if (opened.kind === 'unmatched') return update(unmatchedPayload(table));
  return update(resultPayload(opened.table, opened.state, opened, settings, em));
}

/** 掲示を、いまの張り具合で描き直す。 */
async function refreshBoard(ctx, table, settings) {
  if (!table?.message_id) return;
  const state = stateOf(table);
  if (state.dice) return; // 開いたあとは結果が出ている
  await ctx.rest
    .editMessage(table.channel_id, table.message_id, boardPayload(table, state, settings))
    .catch((error) => console.error('丁半の盆の更新に失敗:', error));
}

/* ------------------------------------------------------------------ 表示 */

/** 片方ぶんの張り紙。 */
function sideLines(state, side) {
  const bets = state.bets.filter((bet) => bet.side === side);
  if (bets.length === 0) return '　（まだ誰も張っていません）';
  return bets.map((bet) => `　<@${bet.userId}>　${bet.amount}`).join('\n');
}

function boardPayload(table, state, settings) {
  const cho = totalOn(state.bets, CHO);
  const han = totalOn(state.bets, HAN);
  const matched = ready(state.bets);

  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `🏺 丁半博打　一口 ${table.bet}`,
        description:
          `<@${table.host_id}> が盆を開きました。壺の中のサイコロ2つの和が\n` +
          '**丁（偶数）** か **半（奇数）** か。当たった側が、外れた側の金を張った額の比で分けます。\n\n' +
          `ボタンを押すたび一口 ${coins(table.bet, settings)} ずつ。何度でも足せますが、反対側へは移れません。\n\n` +
          `**${SIDES[CHO].emoji} 丁（偶数）　計 ${cho}**\n${sideLines(state, CHO)}\n\n` +
          `**${SIDES[HAN].emoji} 半（奇数）　計 ${han}**\n${sideLines(state, HAN)}\n\n` +
          (matched ? '両方にコマが入りました。親は壺を開けられます。' : '**片方にコマが無いと開けません**（不成立なら全額返ります）。'),
        footer: { text: '3分で自動的に開きます' },
      }),
    ],
    components: [
      row(
        button(`ch:bet:${table.id}:${CHO}`, `丁（偶数）に ${table.bet}`, {
          emoji: SIDES[CHO].emoji,
          style: ButtonStyle.PRIMARY,
        }),
        button(`ch:bet:${table.id}:${HAN}`, `半（奇数）に ${table.bet}`, {
          emoji: SIDES[HAN].emoji,
          style: ButtonStyle.DANGER,
        }),
      ),
      row(
        button(`ch:open:${table.id}`, '壺を開ける（親）', {
          emoji: '🏺',
          style: ButtonStyle.SUCCESS,
          disabled: !matched,
        }),
      ),
    ],
  };
}

function unmatchedPayload(table) {
  return {
    content: '',
    embeds: [
      embed({
        color: 0x95a5a6,
        title: '🏺 コマがそろわず、勝負は流れました',
        description:
          '丁と半の両方にコマが入らないと勝負になりません。張ったぶんは全員に返しました。',
      }),
    ],
    components: [againRow(table)],
  };
}

function resultPayload(table, state, opened, settings, em) {
  const { dice, winningSide, result } = opened;
  const faces = diceFaces(em);
  const side = SIDES[winningSide];
  const paid = new Map(result.winners.map((winner) => [winner.userId, winner]));

  const lines = state.bets.map((bet) => {
    const won = paid.get(bet.userId);
    if (!won) return `　<@${bet.userId}>　${SIDES[bet.side].emoji} ${bet.amount} → **−${bet.amount}**`;
    const net = won.payout - bet.stake;
    return `　<@${bet.userId}>　${SIDES[bet.side].emoji} ${bet.amount} → **+${net}**`;
  });

  return {
    // 出目だけを content に置くと大きく描かれる
    content: `${faces[dice[0]]}${faces[dice[1]]}`,
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${side.emoji} ${side.label}！　（${dice[0]} ＋ ${dice[1]} ＝ ${dice[0] + dice[1]}）`,
        description: `**${side.label}（${side.reading}）の勝ち。** 場の ${coins(result.pot, settings)} を分けました。\n\n${lines.join('\n')}`,
        footer: { text: `一口 ${table.bet}` },
      }),
    ],
    components: [againRow(table)],
  };
}

function againRow(table) {
  return row(
    button(`ch:again:${table.id}`, `もう一度（一口 ${table.bet}）`, { emoji: '🔁', style: ButtonStyle.SUCCESS }),
  );
}

/* ------------------------------------------------------------------ もう一度 */

async function handleAgain(ix, ctx, table) {
  const settings = await getSettings(ctx.db, table.guild_id);
  const opened = await openBoard(ctx, {
    guildId: table.guild_id,
    channelId: table.channel_id,
    hostId: ix.userId,
    bet: table.bet,
    settings,
  });
  if (!opened.ok) return reply({ content: 'このチャンネルに新しい盆を開けませんでした。' });
  return update({ components: [] });
}

/* ------------------------------------------------------------------ 時間切れ */

/**
 * 1分ごとの見回りから呼ばれる。
 * コマがそろっていれば、時間切れでもちゃんと開ける（張った金を無駄にしない）。
 * そろっていなければ不成立で返金。
 */
export async function timeOut(ctx, table) {
  const state = stateOf(table);

  if (ready(state.bets)) {
    const opened = await openPot(ctx.db, table);
    if (opened.kind === 'settled') {
      const settings = await getSettings(ctx.db, table.guild_id);
      return { payload: resultPayload(opened.table, opened.state, opened, settings, await ctx.emoji()) };
    }
  }

  await refundTable(ctx.db, table, state);
  await setStatus(ctx.db, table.id, 'cancelled');
  return { payload: unmatchedPayload(table) };
}
