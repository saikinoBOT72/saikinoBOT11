/**
 * ピッグの、チャンネルに出る公開メッセージ。
 *
 * 【隠すものが無い】
 * このゲームは情報が全部公開。手札のような隠しごとが無いので、
 * 掲示1枚をみんなで押し合うだけで成り立つ。
 *
 * 【進み方】
 *   joining → 2〜4人が座る
 *   playing → 手番の人が「振る」か「やめる」。1が出たら貯金が消えて次の人
 *   done    → 先に100点へ届いた人が場を総取り
 */
import {
  GOAL,
  MAX_PLAYERS,
  MIN_PLAYERS,
  createTable,
  current,
  getTable,
  hold,
  isTurn,
  joinTable,
  mutate,
  payWinner,
  potOf,
  refundTable,
  roll,
  seatOf,
  setMessageId,
  setStatus,
  start,
  stateOf,
} from '../lib/pig-table.js';
import { bar, remaining } from '../lib/pig.js';
import { getSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `pg:` 始まり。 */
export const namespace = 'pg';

const COLOR = 0xe67e22;

/* ------------------------------------------------------------------ 卓を立てる */

export async function openTable(ctx, { guildId, channelId, hostId, bet, settings }) {
  const id = crypto.randomUUID();
  await createTable(ctx.db, { id, guildId, channelId, hostId, bet });

  const joined = await joinTable(ctx.db, await getTable(ctx.db, id), hostId);
  if (!joined.ok) {
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: joined.reason };
  }

  try {
    const message = await ctx.rest.createMessage(
      channelId,
      lobbyPayload(await getTable(ctx.db, id), joined.state, settings),
    );
    await setMessageId(ctx.db, id, message.id);
    return { ok: true, message };
  } catch (error) {
    console.error('ピッグの卓の投稿に失敗:', error);
    await refundTable(ctx.db, await getTable(ctx.db, id), joined.state);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }
}

/* ------------------------------------------------------------------ 振り分け */

export async function handleComponent(ix, ctx) {
  const [, action, id] = ix.customId.split(':');
  const table = await getTable(ctx.db, id);

  if (action === 'again') {
    if (!table) return reply({ content: 'この卓の記録が見つかりませんでした。' });
    return handleAgain(ix, ctx, table);
  }
  if (!table || table.status === 'done' || table.status === 'cancelled') {
    return reply({ content: 'この卓はもう終わっています。' });
  }

  const settings = await getSettings(ctx.db, table.guild_id);
  if (action === 'join') return handleJoin(ix, ctx, table, settings);
  if (action === 'start') return handleStart(ix, ctx, table, settings);
  if (action === 'roll') return handleRoll(ix, ctx, table, settings);
  if (action === 'hold') return handleHold(ix, ctx, table, settings);
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 座る・始める */

async function handleJoin(ix, ctx, table, settings) {
  if (table.status !== 'joining') return update(boardPayload(table, stateOf(table), settings));

  const joined = await joinTable(ctx.db, table, ix.userId);
  if (!joined.ok) {
    const messages = {
      already: 'もう座っています。',
      full: `この卓は ${MAX_PLAYERS} 人までです。`,
      insufficient: `参加費 ${coins(table.bet, settings)} が払えません。`,
      closed: 'この卓はもう始まっています。',
    };
    return reply({ content: messages[joined.reason] ?? '座れませんでした。' });
  }
  return update(lobbyPayload(await getTable(ctx.db, table.id), joined.state, settings));
}

async function handleStart(ix, ctx, table, settings) {
  if (ix.userId !== table.host_id) return reply({ content: '始められるのは卓を立てた人だけです。' });
  if (stateOf(table).players.length < MIN_PLAYERS) {
    return reply({ content: `${MIN_PLAYERS}人集まらないと始められません。` });
  }

  const started = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (state.players.length < MIN_PLAYERS) return { reject: 'few' };
      return { state: start(state), status: 'playing' };
    },
    { allow: ['joining'] },
  );
  if (!started.ok) return update(boardPayload(await getTable(ctx.db, table.id), stateOf(await getTable(ctx.db, table.id)), settings));
  return update(boardPayload(started.table, started.state, settings));
}

/* ------------------------------------------------------------------ 振る・やめる */

async function handleRoll(ix, ctx, table, settings) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていません。' });
  if (!isTurn(state, ix.userId)) return reply({ content: `いまは <@${current(state)?.userId}> の番です。` });

  const rolled = await mutate(
    ctx.db,
    table.id,
    ({ state: now }) => {
      if (!isTurn(now, ix.userId)) return { reject: 'turn' };
      const result = roll(now);
      return { state: result.state, status: result.won ? 'done' : 'playing', extra: result };
    },
    { allow: ['playing'] },
  );
  if (!rolled.ok) return reply({ content: 'ほかの人が先に動きました。' });

  if (rolled.extra.won) return finish(ctx, rolled.table, rolled.state, settings);
  return update(boardPayload(rolled.table, rolled.state, settings));
}

async function handleHold(ix, ctx, table, settings) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていません。' });
  if (!isTurn(state, ix.userId)) return reply({ content: `いまは <@${current(state)?.userId}> の番です。` });
  if (state.turnTotal === 0) return reply({ content: 'まだ何も貯まっていません。まず振ってください。' });

  const held = await mutate(
    ctx.db,
    table.id,
    ({ state: now }) => {
      if (!isTurn(now, ix.userId)) return { reject: 'turn' };
      if (now.turnTotal === 0) return { reject: 'empty' };
      return { state: hold(now) };
    },
    { allow: ['playing'] },
  );
  if (!held.ok) return reply({ content: 'ほかの人が先に動きました。' });
  return update(boardPayload(held.table, held.state, settings));
}

/** 上がった。場を渡して結果を出す。 */
async function finish(ctx, table, state, settings) {
  const pot = await payWinner(ctx.db, table, state, state.winner);
  return update(resultPayload(table, state, pot, settings));
}

/* ------------------------------------------------------------------ 表示 */

function lobbyPayload(table, state, settings) {
  const seats = state.players.map((player) => `　<@${player.userId}>`).join('\n') || '　（まだ誰もいません）';
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `🐷 ピッグ　参加費 ${table.bet}`,
        description:
          `<@${table.host_id}> が卓を立てました。**${MIN_PLAYERS}〜${MAX_PLAYERS}人**で遊べます。\n\n` +
          `参加費は ${coins(table.bet, settings)}。サイコロを振って点を足し、先に **${GOAL}点** で場を総取り。\n` +
          '**ただし1が出たら、そのターンに貯めた点はぜんぶ消えます。**\n\n' +
          `**席（${state.players.length}/${MAX_PLAYERS}）**\n${seats}`,
        footer: { text: '2分以内に始まらなければ流れます' },
      }),
    ],
    components: [
      row(
        button(`pg:join:${table.id}`, '座る', { emoji: '👋', style: ButtonStyle.SUCCESS }),
        button(`pg:start:${table.id}`, '始める（親）', {
          emoji: '▶️',
          style: ButtonStyle.PRIMARY,
          disabled: state.players.length < MIN_PLAYERS,
        }),
      ),
    ],
  };
}

/** いまの状態にあった掲示。 */
function boardPayload(table, state, settings) {
  if (table.status === 'joining') return lobbyPayload(table, state, settings);

  const turn = current(state);
  const lines = state.players.map((player, index) => {
    const mark = index === state.turn ? '👉' : '　';
    return `${mark}<@${player.userId}>　${bar(player.score)}　**${player.score}**`;
  });

  // 直前に何が起きたかを1行で。振った人が結果を読めるように
  const flash = state.busted
    ? `💥 **1が出た！** 貯めた点は消えました。`
    : state.held != null
      ? `✋ **${state.held}点**を確定しました。`
      : state.lastRoll
        ? `🎲 **${state.lastRoll}** が出ました。`
        : null;

  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `🐷 ピッグ　${GOAL}点先取`,
        description:
          (flash ? `${flash}\n\n` : '') +
          `${lines.join('\n')}\n\n` +
          `**<@${turn.userId}> の番**\n` +
          `このターンの貯金 **${state.turnTotal}**　　上がりまで あと **${remaining(turn.score, state.turnTotal)}**`,
        fields: [{ name: '場', value: coins(potOf(table, state), settings), inline: true }],
        footer: { text: '1が出たら貯金は消える' },
      }),
    ],
    components: [
      row(
        button(`pg:roll:${table.id}`, '振る', { emoji: '🎲', style: ButtonStyle.PRIMARY }),
        button(`pg:hold:${table.id}`, `やめる（+${state.turnTotal}）`, {
          emoji: '✋',
          style: ButtonStyle.SUCCESS,
          disabled: state.turnTotal === 0,
        }),
      ),
    ],
  };
}

function resultPayload(table, state, pot, settings) {
  const lines = state.players.map(
    (player) => `　<@${player.userId}>　${bar(player.score)}　**${player.score}**`,
  );
  return {
    // 大きく出したいので content には絵文字だけを置く
    content: '🐷🎲',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: '🏆 上がり！',
        description:
          `**<@${state.winner}> の勝ち！** ${coins(pot, settings)} を総取り\n\n${lines.join('\n')}`,
        footer: { text: `参加費 ${table.bet}` },
      }),
    ],
    components: [
      row(button(`pg:again:${table.id}`, `もう一度（${table.bet}）`, { emoji: '🔁', style: ButtonStyle.SUCCESS })),
    ],
  };
}

/* ------------------------------------------------------------------ もう一度 */

async function handleAgain(ix, ctx, table) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていた人だけが押せます。' });

  const settings = await getSettings(ctx.db, table.guild_id);
  const opened = await openTable(ctx, {
    guildId: table.guild_id,
    channelId: table.channel_id,
    hostId: ix.userId,
    bet: table.bet,
    settings,
  });
  if (!opened.ok) {
    const messages = {
      insufficient: `参加費 ${coins(table.bet, settings)} が払えません。`,
      post: 'このチャンネルに新しい卓を立てられませんでした。',
    };
    return reply({ content: messages[opened.reason] ?? '新しい卓を立てられませんでした。' });
  }
  return update({ components: [] });
}

/* ------------------------------------------------------------------ 時間切れ */

/** 1分ごとの見回りから呼ばれる。預かったぶんを返して流す。 */
export async function timeOut(ctx, table) {
  await refundTable(ctx.db, table, stateOf(table));
  await setStatus(ctx.db, table.id, 'cancelled');
  return {
    payload: {
      content: '',
      embeds: [
        embed({
          color: 0x95a5a6,
          title: '⌛ ピッグは流れました',
          description: '時間切れです。預かっていた参加費は全員に返しました。',
        }),
      ],
      components: [],
    },
  };
}
