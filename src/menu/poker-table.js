/**
 * 5枚ポーカーの、チャンネルに出る公開メッセージ。
 *
 * 【手札の隠し方】
 * 公開の卓には手札を一切出さない。「🂠 手札を見る」を押すと、
 * 押した本人にだけ見えるメッセージで5枚を返す。札のボタンを押すと
 * 「残す／捨てる」が切り替わり、「交換する」で引き直す。
 * 本人だけのメッセージなので、何度押しても他人には見えない。
 *
 * 【進み方】
 *   joining → 2〜4人が座る
 *   draw    → 全員が1回ずつ交換
 *   bet     → 勝負（参加費と同額を追加）か、降りる
 *   done    → 残った人で役比べ
 */
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  createTable,
  deal,
  decide,
  everyoneDecided,
  everyoneExchanged,
  exchange,
  getTable,
  joinTable,
  mutate,
  playerOf,
  refundTable,
  seatOf,
  setMessageId,
  setStatus,
  settleTable,
  stateOf,
  stayers,
  takeCall,
  toggleKeep,
} from '../lib/poker-table.js';
import { render, renderHand } from '../lib/cards.js';
import { evaluate } from '../lib/poker.js';
import { deposit, getSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { deferUpdate, reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `pk:` 始まり。 */
export const namespace = 'pk';

const COLOR = 0x2c3e50;

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
    console.error('ポーカーの卓の投稿に失敗:', error);
    await refundTable(ctx.db, await getTable(ctx.db, id), joined.state);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }
}

/* ------------------------------------------------------------------ 振り分け */

export async function handleComponent(ix, ctx) {
  const [, action, id, arg] = ix.customId.split(':');
  const table = await getTable(ctx.db, id);

  if (action === 'again') {
    if (!table) return reply({ content: 'この卓の記録が見つかりませんでした。' });
    return handleAgain(ix, ctx, table);
  }
  if (!table || table.status === 'done' || table.status === 'cancelled') {
    return reply({ content: 'この卓はもう終わっています。' });
  }

  const settings = await getSettings(ctx.db, table.guild_id);

  // 札を出す操作のときだけ絵文字を読む。座る・始めるを軽くして、
  // Discord の3秒の制限に余裕を持たせるため
  if (action === 'join') return handleJoin(ix, ctx, table, settings);
  if (action === 'start') return handleStart(ix, ctx, table, settings);
  if (action === 'hand') return handleHand(ix, ctx, table, settings, await ctx.emoji());
  if (action === 'keep') return handleKeep(ix, ctx, table, Number(arg), settings, await ctx.emoji());
  if (action === 'swap') return handleSwap(ix, ctx, table, settings, await ctx.emoji());
  if (action === 'call' || action === 'fold') {
    return handleDecide(ix, ctx, table, action, settings, await ctx.emoji());
  }
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 座る・始める */

/**
 * いまの状態にあった掲示を作る。
 * 応答が届かずに掲示が取り残されたとき、次に押された操作で追いつかせるのに使う。
 */
function boardPayloadFor(table, state, settings) {
  if (state.phase === 'bet') return betPayload(table, state, settings);
  if (state.phase === 'draw') return drawPayload(table, state, settings);
  return lobbyPayload(table, state, settings);
}

/** 掲示が古いまま取り残されていたら、いまの状態に描き直して返す。 */
async function catchUp(ctx, tableId, settings) {
  const table = await getTable(ctx.db, tableId);
  if (!table) return reply({ content: 'この卓は見つかりませんでした。' });
  return update(boardPayloadFor(table, stateOf(table), settings));
}

async function handleJoin(ix, ctx, table, settings) {
  // もう始まっているのに募集中の掲示が出ているのは、前の応答が届かなかったとき。
  // 掲示をいまの状態に追いつかせる
  if (table.status !== 'joining') return catchUp(ctx, table.id, settings);

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

/**
 * 配る。
 *
 * 【先に「受け取った」と返す理由】
 * Discord は3秒以内に何か返さないと「時間内に応答しませんでした」と出す。
 * 配るのは重い処理ではないが、混み合ったときや久しぶりの起動で間に合わないことがある。
 * 先に受け取ったとだけ返しておけば、そのあと15分かけて書き換えられるので、
 * 「押したのに何も起きない」が起きなくなる。
 */
async function handleStart(ix, ctx, table, settings) {
  if (ix.userId !== table.host_id) return reply({ content: '始められるのは卓を立てた人だけです。' });

  // 人数が足りないのは先に分かるので、ここだけは普通に返す
  if (stateOf(table).players.length < MIN_PLAYERS) {
    return reply({ content: `${MIN_PLAYERS}人集まらないと始められません。` });
  }

  ctx.waitUntil(dealAndShow(ix, ctx, table, settings));
  return deferUpdate();
}

/** 配って、押されたメッセージを書き換える。 */
async function dealAndShow(ix, ctx, table, settings) {
  const started = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (state.players.length < MIN_PLAYERS) return { reject: 'few' };
      return { state: deal(state), status: 'playing' };
    },
    { allow: ['joining'] },
  );

  // 配れていれば新しい掲示。配れなくても（すでに始まっていた等）いまの状態を出す
  const payload = started.ok
    ? drawPayload(started.table, started.state, settings)
    : boardPayloadFor(await getTable(ctx.db, table.id), stateOf(await getTable(ctx.db, table.id)), settings);

  await ctx.rest
    .editOriginalResponse(ix.raw.application_id, ix.raw.token, payload)
    .catch((error) => console.error('ポーカーの配り直後の表示に失敗:', error));
}

/* ------------------------------------------------------------------ 手札（本人だけ） */

/** 本人にだけ見える手札。段階によって出すボタンが変わる。 */
function handPayload(table, state, userId, settings, em, notice = null) {
  const player = playerOf(state, userId);
  const hand = evaluate(player.cards);

  if (player.folded) {
    return {
      embeds: [
        embed({
          color: COLOR,
          title: '🏳️ 降りました',
          description: `${renderHand(em, player.cards)}\n**${hand.label}**`,
        }),
      ],
      components: [],
    };
  }

  // 交換の段階：札を押して「残す／捨てる」を切り替える
  if (state.phase === 'draw' && !player.exchanged) {
    const discards = player.keep.filter((keep) => !keep).length;
    return {
      embeds: [
        withNoticeLine(
          embed({
            color: COLOR,
            title: `🂠 あなたの手札　${hand.label}`,
            description:
              `${renderHand(em, player.cards)}\n\n` +
              '札を押すと「残す／捨てる」が切り替わります。\n' +
              `いま **${discards}枚** 捨てる設定です（5枚まで替えられます）。`,
          }),
          notice,
        ),
      ],
      components: [
        row(...player.cards.map((card, index) => keepButton(table.id, em, card, player.keep[index], index))),
        row(
          button(`pk:swap:${table.id}`, discards === 0 ? 'このまま勝負へ' : `${discards}枚を交換する`, {
            emoji: '🔁',
            style: ButtonStyle.SUCCESS,
          }),
        ),
      ],
    };
  }

  // 勝負の段階：手札を見ながら決める
  if (state.phase === 'bet' && !player.called) {
    return {
      embeds: [
        withNoticeLine(
          embed({
            color: COLOR,
            title: `🂠 あなたの手札　${hand.label}`,
            description:
              `${renderHand(em, player.cards)}\n\n` +
              `乗るなら追加で ${coins(table.bet, settings)}。\n` +
              `降りれば参加費の ${coins(table.bet, settings)} だけの負けで済みます。`,
          }),
          notice,
        ),
      ],
      components: [
        row(
          button(`pk:call:${table.id}`, `勝負する（+${table.bet}）`, { emoji: '💪', style: ButtonStyle.SUCCESS }),
          button(`pk:fold:${table.id}`, '降りる', { emoji: '🏳️', style: ButtonStyle.SECONDARY }),
        ),
      ],
    };
  }

  return {
    embeds: [
      withNoticeLine(
        embed({
          color: COLOR,
          title: `🂠 あなたの手札　${hand.label}`,
          description: `${renderHand(em, player.cards)}\n\nほかの人を待っています。`,
        }),
        notice,
      ),
    ],
    components: [],
  };
}

function withNoticeLine(embedObject, notice) {
  if (!notice) return embedObject;
  return { ...embedObject, description: `${notice}\n\n${embedObject.description}` };
}

/** 1枚ぶんのボタン。絵文字が取り込まれていない環境でも読めるようにする。 */
function keepButton(tableId, em, card, keep, index) {
  const face = render(em, card);
  const custom = /^<a?:\w+:\d+>$/.test(face);
  return button(`pk:keep:${tableId}:${index}`, custom ? (keep ? '残す' : '捨てる') : `${face} ${keep ? '残' : '捨'}`, {
    emoji: custom ? face : undefined,
    style: keep ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY,
  });
}

async function handleHand(ix, ctx, table, settings, em) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていません。' });
  if (state.phase === 'joining') return reply({ content: 'まだ配られていません。' });
  return reply(handPayload(table, state, ix.userId, settings, em));
}

async function handleKeep(ix, ctx, table, index, settings, em) {
  const moved = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (state.phase !== 'draw' || player.exchanged) return { reject: 'late' };
      if (!Number.isInteger(index) || index < 0 || index >= player.cards.length) return { reject: 'range' };
      return { state: toggleKeep(state, ix.userId, index) };
    },
    { allow: ['playing'] },
  );
  if (!moved.ok) return reply({ content: 'もう交換は終わっています。' });
  // 本人だけのメッセージを書き換える。公開の卓は動かない
  return update(handPayload(moved.table, moved.state, ix.userId, settings, em));
}

async function handleSwap(ix, ctx, table, settings, em) {
  const swapped = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (state.phase !== 'draw' || player.exchanged) return { reject: 'late' };
      return { state: exchange(state, ix.userId) };
    },
    { allow: ['playing'] },
  );
  if (!swapped.ok) return reply({ content: 'もう交換は終わっています。' });

  await advanceIfReady(ctx, table.id, settings, em);
  const fresh = await getTable(ctx.db, table.id);
  ctx.waitUntil(refreshBoard(ctx, fresh, settings, em));
  return update(handPayload(fresh, stateOf(fresh), ix.userId, settings, em, '🔁 引き直しました。'));
}

/* ------------------------------------------------------------------ 勝負・降りる */

async function handleDecide(ix, ctx, table, action, settings, em) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていません。' });
  if (state.phase !== 'bet') return reply({ content: 'いまは勝負を決める場面ではありません。' });

  // 乗るなら先にお金を預かる。払えなければ降りた扱いにする
  let folding = action === 'fold';
  if (!folding && !(await takeCall(ctx.db, table, ix.userId))) {
    folding = true;
  }

  const decided = await mutate(
    ctx.db,
    table.id,
    ({ state: current }) => {
      const player = playerOf(current, ix.userId);
      if (!player) return { reject: 'seat' };
      if (current.phase !== 'bet' || player.called || player.folded) return { reject: 'late' };
      const next = decide(current, ix.userId, { fold: folding });
      if (folding) return { state: next };
      return {
        state: {
          ...next,
          players: next.players.map((p) =>
            p.userId === ix.userId ? { ...p, staked: p.staked + table.bet } : p,
          ),
        },
      };
    },
    { allow: ['playing'] },
  );
  if (!decided.ok) {
    // 預かったのに記録できなかったら返す
    if (!folding) await refundCall(ctx, table, ix.userId);
    return reply({ content: 'もう決まっています。' });
  }

  await advanceIfReady(ctx, table.id, settings, em);
  const fresh = await getTable(ctx.db, table.id);
  ctx.waitUntil(refreshBoard(ctx, fresh, settings, em));

  return reply({
    content: folding
      ? action === 'fold'
        ? '降りました。'
        : `追加の ${table.bet} が払えなかったので降りました。`
      : `勝負しました（+${table.bet}）。`,
  });
}

async function refundCall(ctx, table, userId) {
  await deposit(ctx.db, table.guild_id, userId, table.bet, 'poker:refund', table.id);
}

/* ------------------------------------------------------------------ 進行 */

/**
 * 全員が済んでいたら次の段階へ進める。
 * 進める権利は1つの書き込みだけが取れるので、二重に精算されない。
 */
async function advanceIfReady(ctx, id, settings, em) {
  const toBet = await mutate(
    ctx.db,
    id,
    ({ state }) => {
      if (state.phase !== 'draw' || !everyoneExchanged(state)) return { reject: 'wait' };
      return { state: { ...state, phase: 'bet' } };
    },
    { allow: ['playing'] },
  );
  if (toBet.ok) return;

  const toDone = await mutate(
    ctx.db,
    id,
    ({ state }) => {
      if (state.phase !== 'bet' || !everyoneDecided(state)) return { reject: 'wait' };
      return { state: { ...state, phase: 'done' }, status: 'done' };
    },
    { allow: ['playing'] },
  );
  if (!toDone.ok) return;

  const result = await settleTable(ctx.db, toDone.table, toDone.state);
  ctx.waitUntil(
    (async () => {
      const table = await getTable(ctx.db, id);
      if (!table?.message_id) return;
      await ctx.rest
        .editMessage(table.channel_id, table.message_id, resultPayload(table, toDone.state, result, settings, em))
        .catch((error) => console.error('ポーカーの結果表示に失敗:', error));
    })(),
  );
}

/** 公開の卓を、いまの状態で描き直す。 */
async function refreshBoard(ctx, table, settings, em) {
  if (!table?.message_id) return;
  const state = stateOf(table);
  if (state.phase === 'done') return; // 結果は advanceIfReady が出す
  const payload = state.phase === 'bet' ? betPayload(table, state, settings) : drawPayload(table, state, settings);
  await ctx.rest
    .editMessage(table.channel_id, table.message_id, payload)
    .catch((error) => console.error('ポーカーの卓の更新に失敗:', error));
}

/* ------------------------------------------------------------------ 表示 */

function lobbyPayload(table, state, settings) {
  const seats = state.players.map((player) => `　<@${player.userId}>`).join('\n') || '　（まだ誰もいません）';
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `♠️ ポーカー　参加費 ${table.bet}`,
        description:
          `<@${table.host_id}> が卓を立てました。**${MIN_PLAYERS}〜${MAX_PLAYERS}人**で遊べます。\n\n` +
          '5枚配って、いらない札を1回だけ引き直し。そのあと勝負か降りるかを決めます。\n\n' +
          `**席（${state.players.length}/${MAX_PLAYERS}）**\n${seats}`,
        footer: { text: '2分以内に始まらなければ流れます' },
      }),
    ],
    components: [
      row(
        button(`pk:join:${table.id}`, '座る', { emoji: '👋', style: ButtonStyle.SUCCESS }),
        button(`pk:start:${table.id}`, '始める（親）', {
          emoji: '▶️',
          style: ButtonStyle.PRIMARY,
          disabled: state.players.length < MIN_PLAYERS,
        }),
      ),
    ],
  };
}

function drawPayload(table, state, settings) {
  const lines = state.players.map(
    (player) => `　<@${player.userId}>　${player.exchanged ? '✅ 交換ずみ' : '⏳ 考え中…'}`,
  );
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: '♠️ ポーカー　札の交換',
        description:
          '**手札は本人にだけ見えます。** 下のボタンから開いて、いらない札を引き直してください。\n\n' +
          lines.join('\n'),
        fields: [{ name: '場', value: coins(potOf(state), settings), inline: true }],
        footer: { text: '5枚まで替えられます' },
      }),
    ],
    components: [row(button(`pk:hand:${table.id}`, '手札を見る', { emoji: '🂠', style: ButtonStyle.PRIMARY }))],
  };
}

function betPayload(table, state, settings) {
  const lines = state.players.map((player) => {
    const mark = player.folded ? '🏳️ 降りた' : player.called ? '💪 勝負！' : '⏳ 考え中…';
    return `　<@${player.userId}>　${mark}`;
  });
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: '♠️ ポーカー　勝負か、降りるか',
        description:
          `乗るなら追加で **${table.bet}**。降りれば参加費の **${table.bet}** だけの負けで済みます。\n\n` +
          lines.join('\n'),
        fields: [{ name: '場', value: coins(potOf(state), settings), inline: true }],
        footer: { text: '手札を見てから決められます' },
      }),
    ],
    components: [
      row(
        button(`pk:hand:${table.id}`, '手札を見る', { emoji: '🂠', style: ButtonStyle.PRIMARY }),
        button(`pk:call:${table.id}`, `勝負する（+${table.bet}）`, { emoji: '💪', style: ButtonStyle.SUCCESS }),
        button(`pk:fold:${table.id}`, '降りる', { emoji: '🏳️', style: ButtonStyle.SECONDARY }),
      ),
    ],
  };
}

function potOf(state) {
  return state.players.reduce((sum, player) => sum + player.staked, 0);
}

function resultPayload(table, state, result, settings, em) {
  if (result.kind === 'nobody') {
    return {
      content: '',
      embeds: [
        embed({
          color: 0x95a5a6,
          title: '🤝 全員が降りました',
          description: '勝負は流れました。参加費は全員に返しています。',
        }),
      ],
      components: [rematchRow(table)],
    };
  }

  if (result.kind === 'walkover') {
    const winnerId = result.winners[0].userId;
    return {
      content: '',
      embeds: [
        embed({
          color: 0xf1c40f,
          title: '🏆 ひとり残って総取り',
          description:
            `**<@${winnerId}> の勝ち！**\n` +
            `ほかの全員が降りたので、手札を見せずに ${coins(result.pot, settings)} を持っていきました。`,
        }),
      ],
      components: [rematchRow(table)],
    };
  }

  const best = result.winners[0];
  const winnerHands = new Map(result.hands.map((entry) => [entry.userId, entry]));
  const champion = winnerHands.get(best.userId);

  const lines = state.players.map((player) => {
    if (player.folded) return `　<@${player.userId}>　🏳️ 降りた`;
    const shown = winnerHands.get(player.userId);
    const crown = result.winners.some((winner) => winner.userId === player.userId) ? '　👑' : '';
    return `　<@${player.userId}>　${renderHand(em, shown.cards)}　**${shown.hand.label}**${crown}`;
  });

  const share = Math.floor(result.pot / result.winners.length);
  const verdict =
    result.winners.length === 1
      ? `**<@${best.userId}> の勝ち！** ${coins(result.pot, settings)} を総取り`
      : `**引き分け**。${result.winners.map((winner) => `<@${winner.userId}>`).join(' と ')} で ${coins(share, settings)} ずつ山分け`;

  return {
    // 勝った手を content に絵文字だけで置く。ここがいちばん大きく出る
    content: renderHand(em, champion.cards),
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `🏆 ${champion.hand.label}`,
        description: `${verdict}\n\n${lines.join('\n')}`,
        footer: { text: `参加費 ${table.bet}` },
      }),
    ],
    components: [rematchRow(table)],
  };
}

function rematchRow(table) {
  return row(
    button(`pk:again:${table.id}`, `もう一度（${table.bet}）`, { emoji: '🔁', style: ButtonStyle.SUCCESS }),
  );
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

/** 1分ごとの見回りから呼ばれる。配る前も途中も、預かったぶんを返して流す。 */
export async function timeOut(ctx, table) {
  const state = stateOf(table);
  await refundTable(ctx.db, table, state);
  await setStatus(ctx.db, table.id, 'cancelled');
  return {
    payload: {
      content: '',
      embeds: [
        embed({
          color: 0x95a5a6,
          title: '⌛ ポーカーは流れました',
          description: '時間切れです。預かっていた参加費は全員に返しました。',
        }),
      ],
      components: [],
    },
  };
}

export { stayers };
