/**
 * ブラックジャックの卓。チャンネルに出る公開メッセージ。
 * 3人まで座って、それぞれがディーラー（Bot）と勝負する。
 */
import {
  MAX_PLAYERS,
  canDouble,
  describeValue,
  handValue,
  isBust,
} from '../lib/blackjack.js';
import {
  JOIN_TIMEOUT_MS,
  createTable,
  deal,
  getTable,
  joinTable,
  mutate,
  nextActive,
  playDealer,
  refundTable,
  seatOf,
  setMessageId,
  setStatus,
  settleTable,
  stateOf,
} from '../lib/blackjack-table.js';
import { draw } from '../lib/cards.js';
import { renderHand } from '../lib/cards.js';
import { getSettings, withdraw } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `bj:` 始まり。 */
export const namespace = 'bj';

const COLOR = 0x1abc9c;

/** 卓を立ててチャンネルに投稿する。 */
export async function openTable(ctx, { guildId, channelId, hostId, bet, settings }) {
  const id = crypto.randomUUID();
  await createTable(ctx.db, { id, guildId, channelId, hostId, bet });

  const joined = await joinTable(ctx.db, await getTable(ctx.db, id), hostId);
  if (!joined.ok) {
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: joined.reason };
  }

  const em = await ctx.emoji();
  try {
    const table = await getTable(ctx.db, id);
    const message = await ctx.rest.createMessage(channelId, lobbyPayload(table, joined.state, settings, em));
    await setMessageId(ctx.db, id, message.id);
    return { ok: true, message };
  } catch (error) {
    console.error('ブラックジャックの卓の投稿に失敗:', error);
    await refundTable(ctx.db, await getTable(ctx.db, id), joined.state);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }
}

export async function handleComponent(ix, ctx) {
  const [, action, id] = ix.customId.split(':');
  const table = await getTable(ctx.db, id);
  if (!table || table.status === 'done' || table.status === 'cancelled') {
    return reply({ content: 'この卓はもう終わっています。' });
  }

  const settings = await getSettings(ctx.db, table.guild_id);
  const em = await ctx.emoji();

  if (action === 'join') return handleJoin(ix, ctx, table, settings, em);
  if (action === 'start') return handleStart(ix, ctx, table, settings, em);
  if (action === 'hit' || action === 'stand' || action === 'double') {
    return handleMove(ix, ctx, table, action, settings, em);
  }
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 席につく・始める */

async function handleJoin(ix, ctx, table, settings, em) {
  if (table.status !== 'joining') return reply({ content: 'この卓はもう始まっています。' });

  const joined = await joinTable(ctx.db, table, ix.userId);
  if (!joined.ok) {
    const messages = {
      already: 'すでに座っています。',
      full: `この卓は ${MAX_PLAYERS} 人までです。`,
      insufficient: `残高が足りません（参加費 ${table.bet}）。`,
      closed: 'この卓はもう始まっています。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[joined.reason] ?? '座れませんでした。' });
  }

  // 満席になったらそのまま始める
  if (joined.state.players.length >= MAX_PLAYERS) {
    return startRound(ix, ctx, await getTable(ctx.db, table.id), settings, em);
  }
  return update(lobbyPayload(joined.table, joined.state, settings, em));
}

async function handleStart(ix, ctx, table, settings, em) {
  if (table.status !== 'joining') return reply({ content: 'この卓はもう始まっています。' });
  if (ix.userId !== table.host_id) return reply({ content: '始められるのは卓を立てた人だけです。' });
  return startRound(ix, ctx, table, settings, em);
}

async function startRound(ix, ctx, table, settings, em) {
  const dealt = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (state.players.length === 0) return { reject: 'empty' };
      return { state: deal(state), status: 'playing' };
    },
    { allow: ['joining'] },
  );
  if (!dealt.ok) return reply({ content: 'もう始まっています。' });

  // 全員が最初の2枚で21なら、そのままディーラーの番
  if (dealt.state.turn < 0) return finish(ix, ctx, dealt.table, dealt.state, settings, em);

  ctx.animate(ix, [{ after: 900, payload: tablePayload(dealt.table, dealt.state, settings, em) }]);
  return update(dealingPayload(em));
}

/* ------------------------------------------------------------------ ヒット・スタンド・ダブル */

async function handleMove(ix, ctx, table, action, settings, em) {
  if (table.status !== 'playing') return reply({ content: 'まだ始まっていません。' });

  const current = stateOf(table);
  const seat = seatOf(current, ix.userId);
  if (seat < 0) return reply({ content: 'この卓に座っていません。' });
  if (current.turn !== seat) return reply({ content: 'いまはあなたの番ではありません。' });

  // ダブルダウンは先に追加の賭け金を預かる
  if (action === 'double') {
    if (!canDouble(current.players[seat])) return reply({ content: 'ダブルダウンは最初の2枚のときだけです。' });
    if (!(await withdraw(ctx.db, table.guild_id, ix.userId, table.bet, 'blackjack:double', table.id))) {
      return reply({ content: `残高が足りません（あと ${table.bet} 必要です）。` });
    }
  }

  const moved = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (state.turn !== seat) return { reject: 'turn' };
      const players = state.players.map((player) => ({ ...player }));
      const hand = players[seat];
      if (hand.status !== 'playing') return { reject: 'turn' };

      const deck = [...state.deck];
      if (action === 'hit' || action === 'double') {
        hand.cards = [...hand.cards, draw(deck)];
        if (action === 'double') hand.doubled = true;
      }

      if (action === 'stand') hand.status = 'stand';
      else if (isBust(hand.cards)) hand.status = 'bust';
      else if (action === 'double') hand.status = 'stand';
      else if (handValue(hand.cards).total === 21) hand.status = 'stand';

      const turn = hand.status === 'playing' ? seat : nextActive(players, seat);
      return { state: { ...state, deck, players, turn }, extra: { hand } };
    },
    { allow: ['playing'] },
  );

  if (!moved.ok) {
    if (action === 'double') {
      // 預かった追加分を戻す
      const { deposit } = await import('../lib/economy.js');
      await deposit(ctx.db, table.guild_id, ix.userId, table.bet, 'blackjack:refund', table.id);
    }
    const messages = { turn: 'いまはあなたの番ではありません。', closed: 'この卓はもう終わっています。' };
    return reply({ content: messages[moved.reason] ?? '進められませんでした。' });
  }

  if (moved.state.turn < 0) return finish(ix, ctx, moved.table, moved.state, settings, em);
  return update(tablePayload(moved.table, moved.state, settings, em));
}

/* ------------------------------------------------------------------ ディーラーの番と精算 */

async function finish(ix, ctx, table, state, settings, em) {
  const played = playDealer(state);
  const results = await settleTable(ctx.db, table, played);
  if (!results) return reply({ content: 'この卓はもう精算済みです。' });

  ctx.animate(ix, [
    { after: 900, payload: revealPayload(table, played, settings, em) },
    { after: 1100, payload: resultPayload(table, played, results, settings, em) },
  ]);
  return update(tablePayload(table, played, settings, em, { hideDealer: true, frozen: true }));
}

/** 定期処理から呼ぶ。時間切れの卓を片付ける。 */
export async function timeOut(ctx, table) {
  const state = stateOf(table);
  const em = await ctx.emoji();
  const settings = await getSettings(ctx.db, table.guild_id);

  if (table.status === 'joining') {
    await setStatus(ctx.db, table.id, 'cancelled');
    await refundTable(ctx.db, table, state);
    return {
      payload: {
        content: '',
        embeds: [
          embed({
            color: 0x95a5a6,
            title: `${em.joker} ブラックジャック`,
            description: '時間切れで卓を閉じました。参加費は返しました。',
          }),
        ],
        components: [],
      },
    };
  }

  // 進行中なら、残った人はスタンド扱いにしてディーラーまで進める
  const standing = {
    ...state,
    players: state.players.map((player) => (player.status === 'playing' ? { ...player, status: 'stand' } : player)),
    turn: -1,
  };
  const played = playDealer(standing);
  const results = await settleTable(ctx.db, table, played);
  if (!results) return null;
  return { payload: resultPayload(table, played, results, settings, em, '⏰ 時間切れのため、残っていた人はスタンド扱いで進めました。') };
}

/* ------------------------------------------------------------------ 表示 */

function lobbyPayload(table, state, settings, em) {
  const seats = state.players.map((player, index) => `${index + 1}. <@${player.userId}>`).join('\n');
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `${em.joker} ブラックジャック`,
        description:
          `<@${table.host_id}> が卓を立てました。**参加費 ${coins(table.bet, settings)}**\n` +
          `**${MAX_PLAYERS}人まで**座れます。全員がディーラー（Bot）と勝負します。\n\n` +
          `**座っている人（${state.players.length}/${MAX_PLAYERS}）**\n${seats}`,
        fields: [{ name: 'ルール', value: RULES }],
        footer: { text: '2分たつと自動で閉じます（参加費は返ります）' },
      }),
    ],
    components: [
      row(
        button(`bj:join:${table.id}`, '座る', { emoji: '🪑', style: ButtonStyle.SUCCESS }),
        button(`bj:start:${table.id}`, '始める（卓主）', { emoji: '▶️', style: ButtonStyle.PRIMARY }),
      ),
    ],
  };
}

const RULES = [
  '21を超えない範囲で、**ディーラーより大きい手**を作れば勝ちです。',
  'A は 11、超えるなら 1。J・Q・K は 10。',
  '**ディーラーは17以上になるまで必ず引きます。**',
  '',
  '最初の2枚で21（**ブラックジャック**）なら **2.5倍**、ふつうの勝ちは **2倍**、引き分けは返却。',
  '**ダブルダウン**（最初の2枚のときだけ）は賭け金を倍にして、1枚だけ引いて終わりです。',
].join('\n');

function dealingPayload(em) {
  return {
    content: '',
    embeds: [
      embed({ color: COLOR, title: `${em.joker} ブラックジャック`, description: `配っています…\n\n# ${em.card_back} ${em.card_back}` }),
    ],
    components: [],
  };
}

function tablePayload(table, state, settings, em, { hideDealer = true, frozen = false } = {}) {
  const turnPlayer = state.turn >= 0 ? state.players[state.turn] : null;
  const lines = state.players.map((player, index) => {
    const mark = index === state.turn ? '▶️' : statusMark(player.status);
    const hand = renderHand(em, player.cards);
    const doubled = player.doubled ? '　*(ダブル)*' : '';
    return `${mark} <@${player.userId}>　${hand}　**${describeValue(player.cards)}**${doubled}`;
  });

  return {
    content: turnPlayer ? `<@${turnPlayer.userId}>` : '',
    embeds: [
      embed({
        color: COLOR,
        title: `${em.joker} ブラックジャック`,
        description:
          `**ディーラー**　${renderHand(em, state.dealer, { hideFrom: hideDealer ? 1 : null })}　` +
          `${hideDealer ? '**?**' : `**${describeValue(state.dealer)}**`}\n\n` +
          `${lines.join('\n')}\n\n` +
          (turnPlayer ? `<@${turnPlayer.userId}> の番です。` : 'ディーラーの番です…'),
        footer: { text: `参加費 ${table.bet}・ディーラーは17以上で止まります` },
      }),
    ],
    components: frozen || !turnPlayer ? [] : [moveRow(table, state.players[state.turn])],
    allowed_mentions: { users: turnPlayer ? [turnPlayer.userId] : [] },
  };
}

function statusMark(status) {
  return { blackjack: '🎉', bust: '💥', stand: '✋', playing: '・' }[status] ?? '・';
}

function moveRow(table, hand) {
  return row(
    button(`bj:hit:${table.id}`, 'ヒット', { emoji: '🃏', style: ButtonStyle.PRIMARY }),
    button(`bj:stand:${table.id}`, 'スタンド', { emoji: '✋', style: ButtonStyle.SECONDARY }),
    button(`bj:double:${table.id}`, 'ダブルダウン', {
      emoji: '💰',
      style: ButtonStyle.DANGER,
      disabled: !canDouble(hand),
    }),
  );
}

function revealPayload(table, state, settings, em) {
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `${em.joker} ブラックジャック`,
        description:
          `**ディーラー**　${renderHand(em, state.dealer)}　**${describeValue(state.dealer)}**\n\n` +
          'ディーラーの手が開きました…',
      }),
    ],
    components: [],
  };
}

function resultPayload(table, state, results, settings, em, headline = null) {
  const byUser = new Map(results.map((result) => [result.userId, result]));
  const lines = state.players.map((player) => {
    const result = byUser.get(player.userId);
    const stake = result?.stake ?? player.bet;
    const gain = (result?.amount ?? 0) - stake;
    const sign = gain > 0 ? `+${gain}` : `${gain}`;
    return (
      `<@${player.userId}>　${renderHand(em, player.cards)}　**${describeValue(player.cards)}**\n` +
      `　${result?.label ?? '—'}　→　**${sign}**`
    );
  });

  return {
    content: '',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${em.joker} ブラックジャック 結果`,
        description:
          (headline ? `${headline}\n\n` : '') +
          `**ディーラー**　${renderHand(em, state.dealer)}　**${describeValue(state.dealer)}**\n\n` +
          lines.join('\n\n'),
        footer: { text: `参加費 ${table.bet}` },
      }),
    ],
    components: [],
    allowed_mentions: { users: state.players.map((player) => player.userId) },
  };
}

export { JOIN_TIMEOUT_MS };
