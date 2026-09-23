/**
 * 簡ポーカーの、チャンネルに出る公開メッセージ。
 *
 * 【手札の隠し方】
 * 公開の卓には手札を一切出さない。「🃏 手札を見る」を押すと、
 * 押した本人にだけ見えるメッセージで5枚を返す。札のボタンを押すと
 * 「残す／捨てる」が切り替わり、「交換する」で引き直す。
 * 本人だけのメッセージなので、何度押しても他人には見えない。
 *
 * 【進み方】
 *   joining → 2〜4人が座る
 *   draw    → 各自2回まで交換（途中でやめてもよい）
 *   bet     → 「提案の周」と「承認の周」の繰り返し。何度でもレイズできる
 *   done    → 残った人で役比べ
 */
import {
  ACCEPT,
  MAX_DRAWS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROPOSE,
  acceptRoundOver,
  actInRound,
  closeAcceptRound,
  closeProposeRound,
  createTable,
  deal,
  everyoneExchanged,
  exchange,
  foldPlayer,
  getTable,
  giveBack,
  joinTable,
  mutate,
  owedBy,
  playerOf,
  proposeRoundOver,
  raiseCap,
  refundTable,
  seatOf,
  setMessageId,
  setStatus,
  settleTable,
  standPat,
  stateOf,
  stayers,
  takeCall,
  toBetPhase,
  toggleKeep,
} from '../lib/poker-table.js';
import { render, renderHand } from '../lib/cards.js';
import { evaluate } from '../lib/poker.js';
import { getBalance, getSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, modal, row, textInput } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { deferUpdate, modalResponse, reply, update } from '../discord/respond.js';
import { readText } from './common.js';

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
    console.error('簡ポーカーの卓の投稿に失敗:', error);
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
  if (action === 'stand') return handleStand(ix, ctx, table, settings, await ctx.emoji());
  if (action === 'call' || action === 'fold') {
    return handleDecide(ix, ctx, table, action, settings, await ctx.emoji());
  }
  if (action === 'raise') return handleRaise(ix, ctx, table, arg, settings, await ctx.emoji());
  if (action === 'raiseform') return handleRaiseForm(ix, ctx, table, settings);
  if (action === 'raisedo') return handleRaiseDo(ix, ctx, table, settings, await ctx.emoji());
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
    .catch((error) => console.error('簡ポーカーの配り直後の表示に失敗:', error));
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
    const left = MAX_DRAWS - (player.draws ?? 0);
    return {
      embeds: [
        withNoticeLine(
          embed({
            color: COLOR,
            title: `🂠 あなたの手札　${hand.label}`,
            description:
              `${renderHand(em, player.cards)}\n\n` +
              '札を押すと「残す／捨てる」が切り替わります。\n' +
              `いま **${discards}枚** 捨てる設定です。\n` +
              `引き直しは **あと${left}回**（毎回5枚まで替えられます）。`,
          }),
          notice,
        ),
      ],
      components: [
        row(...player.cards.map((card, index) => keepButton(table.id, em, card, player.keep[index], index))),
        row(
          button(`pk:swap:${table.id}`, `${discards}枚を交換する`, {
            emoji: '🔁',
            style: ButtonStyle.SUCCESS,
            disabled: discards === 0,
          }),
          button(`pk:stand:${table.id}`, 'これで勝負へ', { emoji: '✅', style: ButtonStyle.PRIMARY }),
        ),
      ],
    };
  }

  // 勝負の段階：手札を見ながら決める
  if (state.phase === 'bet' && myTurn(state, player)) {
    const owed = owedBy(state, player);
    const accepting = state.step === ACCEPT;
    return {
      embeds: [
        withNoticeLine(
          embed({
            color: COLOR,
            title: `🂠 あなたの手札　${hand.label}`,
            description:
              `${renderHand(em, player.cards)}\n\n` +
              (accepting
                ? `**${coins(state.lastRaise ?? owed, settings)} のレイズ**が出ました。\n` +
                  `承認するなら追加で ${coins(owed, settings)}。\n` +
                  `降りれば、いままで出した ${coins(player.staked, settings)} だけの負けで済みます。`
                : owed > 0
                  ? `乗るなら ${coins(owed, settings)}。ここでレイズを提案することもできます。\n` +
                    `降りれば、いままで出した ${coins(player.staked, settings)} だけの負けで済みます。`
                  : 'レイズを提案するか、このまま進めるかを選んでください。\n' +
                    '誰も提案しなければ、ここで役比べになります。'),
          }),
          notice,
        ),
      ],
      components: betRows(table, state, { owed, mine: true }),
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

/** いま自分が押すべき場面か。 */
function myTurn(state, player) {
  if (player.folded) return false;
  return state.step === ACCEPT ? owedBy(state, player) > 0 : !player.acted;
}

function withNoticeLine(embedObject, notice) {
  if (!notice) return embedObject;
  return { ...embedObject, description: `${notice}\n\n${embedObject.description}` };
}

/** 1枚ぶんのボタン。絵文字が取り込まれていない環境でも読めるようにする。 */
function keepButton(tableId, em, card, keep, index) {
  const face = render(em, card);
  const custom = /^<a?:\w+:\d+>$/.test(face);
  return button(`pk:keep:${tableId}:${index}`, custom ? (keep ? '残' : '捨') : `${face} ${keep ? '残' : '捨'}`, {
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
      if (player.keep.every((keep) => keep)) return { reject: 'none' };
      return { state: exchange(state, ix.userId) };
    },
    { allow: ['playing'] },
  );
  if (!swapped.ok) {
    return reply({
      content: swapped.reason === 'none' ? '捨てる札を選んでください。' : 'もう交換は終わっています。',
    });
  }

  const left = MAX_DRAWS - (playerOf(swapped.state, ix.userId).draws ?? 0);
  const notice = left > 0 ? `🔁 引き直しました。あと${left}回替えられます。` : '🔁 引き直しました。';
  return finishDrawStep(ix, ctx, table, settings, em, notice);
}

/** 引き直さずに交換を終える。 */
async function handleStand(ix, ctx, table, settings, em) {
  const stood = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (state.phase !== 'draw' || player.exchanged) return { reject: 'late' };
      return { state: standPat(state, ix.userId) };
    },
    { allow: ['playing'] },
  );
  if (!stood.ok) return reply({ content: 'もう交換は終わっています。' });
  return finishDrawStep(ix, ctx, table, settings, em, '✅ この手で勝負します。');
}

/** 交換の1手が済んだあと。全員そろっていれば次へ進め、画面を描き直す。 */
async function finishDrawStep(ix, ctx, table, settings, em, notice) {
  await advanceIfReady(ctx, table.id, settings, em);
  const fresh = await getTable(ctx.db, table.id);
  ctx.waitUntil(refreshBoard(ctx, fresh, settings, em));
  return update(handPayload(fresh, stateOf(fresh), ix.userId, settings, em, notice));
}

/* ------------------------------------------------------------------ 勝負・降りる */

async function handleDecide(ix, ctx, table, action, settings, em) {
  const state = stateOf(table);
  const player = playerOf(state, ix.userId);
  if (!player) return reply({ content: 'この卓に座っていません。' });
  if (state.phase !== 'bet') return reply({ content: 'いまは勝負を決める場面ではありません。' });
  if (player.folded) return reply({ content: 'もう降りています。' });

  if (action === 'fold') {
    const folded = await mutate(
      ctx.db,
      table.id,
      ({ state: current }) => {
        const now = playerOf(current, ix.userId);
        if (!now || now.folded) return { reject: 'late' };
        if (current.phase !== 'bet') return { reject: 'late' };
        return { state: foldPlayer(current, ix.userId) };
      },
      { allow: ['playing'] },
    );
    if (!folded.ok) return reply({ content: 'もう決まっています。' });
    return afterBetStep(ix, ctx, table, settings, em, '降りました。出したぶんは場に残ります。');
  }

  const owed = owedBy(state, player);
  if (state.step === PROPOSE && player.acted) return reply({ content: 'この周はもう動いています。' });
  if (state.step === ACCEPT && owed === 0) return reply({ content: 'もう承認しています。' });

  // 払うのは自分のぶんだけ。払えなければ降りた扱い（提案から承認までに使われた場合）
  if (owed > 0 && !(await takeCall(ctx.db, table, ix.userId, owed))) {
    return forceFold(ix, ctx, table, settings, em, owed);
  }

  const acted = await mutate(
    ctx.db,
    table.id,
    ({ state: current }) => {
      const now = playerOf(current, ix.userId);
      if (!now || now.folded || current.phase !== 'bet') return { reject: 'late' };
      if (current.step === PROPOSE && now.acted) return { reject: 'late' };
      if (owedBy(current, now) !== owed) return { reject: 'moved' };
      return { state: actInRound(current, ix.userId, { amount: owed }) };
    },
    { allow: ['playing'] },
  );
  if (!acted.ok) {
    if (owed > 0) await giveBack(ctx.db, table, ix.userId, owed);
    return reply({
      content: acted.reason === 'moved' ? '金額が変わりました。開き直してください。' : 'もう決まっています。',
    });
  }

  const word = state.step === ACCEPT ? '承認しました' : owed > 0 ? '勝負しました' : 'このままにしました';
  return afterBetStep(ix, ctx, table, settings, em, owed > 0 ? `${word}（+${owed}）。` : `${word}。`);
}

/** 払えなくなっていた人を降ろす。提案から承認までのあいだに使われた場合に起きる。 */
async function forceFold(ix, ctx, table, settings, em, owed) {
  await mutate(
    ctx.db,
    table.id,
    ({ state: current }) => {
      const now = playerOf(current, ix.userId);
      if (!now || now.folded || current.phase !== 'bet') return { reject: 'late' };
      return { state: foldPlayer(current, ix.userId) };
    },
    { allow: ['playing'] },
  );
  return afterBetStep(
    ix,
    ctx,
    table,
    settings,
    em,
    `${coins(owed, settings)} が払えなくなっていたので降りました。出したぶんは場に残ります。`,
  );
}

/** 勝負の段階で1手動いたあと。周が終わっていれば次へ進め、画面を描き直す。 */
async function afterBetStep(ix, ctx, table, settings, em, content) {
  await advanceIfReady(ctx, table.id, settings, em);
  const fresh = await getTable(ctx.db, table.id);
  ctx.waitUntil(refreshBoard(ctx, fresh, settings, em));
  return reply({ content });
}

/* ------------------------------------------------------------------ レイズの提案 */

/** 「好きな額」の入力フォーム。 */
async function handleRaiseForm(ix, ctx, table, settings) {
  const blocked = raiseBlocked(stateOf(table), ix.userId);
  if (blocked) return reply({ content: blocked });

  const cap = await capFor(ctx, table, stateOf(table));
  if (cap <= 0) return reply({ content: 'これ以上は上げられません。' });

  return modalResponse(
    modal(`pk:raisedo:${table.id}`, 'レイズを提案する', [
      textInput('amount', `いくら上げる？（1〜${cap}）`, {
        placeholder: `例: ${Math.max(1, Math.floor(cap / 2))}`,
        required: true,
        max: 12,
      }),
    ]),
  );
}

async function handleRaiseDo(ix, ctx, table, settings, em) {
  const typed = Number(readText(ix, 'amount'));
  if (!Number.isInteger(typed) || typed <= 0) return reply({ content: '1以上の整数を入れてください。' });
  return raiseBy(ix, ctx, table, typed, settings, em);
}

async function handleRaise(ix, ctx, table, arg, settings, em) {
  const wanted = arg === 'half' ? Math.max(1, Math.floor(table.bet / 2)) : table.bet;
  return raiseBy(ix, ctx, table, wanted, settings, em);
}

/** レイズを出せない理由。出せるなら null。 */
function raiseBlocked(state, userId) {
  const player = playerOf(state, userId);
  if (!player || player.folded) return 'この卓で勝負していません。';
  if (state.phase !== 'bet') return 'いまは勝負を決める場面ではありません。';
  if (state.step !== PROPOSE) return 'いまは、出ているレイズを承認するか降りるかの場面です。';
  if (player.acted) return 'この周はもう動いています。次の周でまた提案できます。';
  return null;
}

/**
 * 上限は「卓に残っている全員が払える額」。
 * ここを超えなければ、承認したい人が払えなくて詰まることがない。
 */
async function capFor(ctx, table, state) {
  const balances = {};
  for (const player of stayers(state)) {
    balances[player.userId] = await getBalance(ctx.db, table.guild_id, player.userId);
  }
  return raiseCap(state, balances);
}

/**
 * レイズを提案する。
 * 出す人は「まだ出していないぶん＋上乗せぶん」をその場で払う。
 * ほかの人からは集めない（集めてから中止する、という後始末を作らないため）。
 */
async function raiseBy(ix, ctx, table, wanted, settings, em) {
  const state = stateOf(table);
  const blocked = raiseBlocked(state, ix.userId);
  if (blocked) return reply({ content: blocked });

  const cap = await capFor(ctx, table, state);
  if (cap <= 0) return reply({ content: '卓の誰かがこれ以上払えないので、上げられません。' });

  const raise = Math.min(wanted, cap);
  const owed = owedBy(state, playerOf(state, ix.userId));
  const total = owed + raise;

  if (!(await takeCall(ctx.db, table, ix.userId, total))) {
    return reply({ content: `${coins(total, settings)} が払えません。` });
  }

  const proposed = await mutate(
    ctx.db,
    table.id,
    ({ state: current }) => {
      const now = playerOf(current, ix.userId);
      if (!now || now.folded || current.phase !== 'bet') return { reject: 'late' };
      if (current.step !== PROPOSE || now.acted) return { reject: 'late' };
      if (owedBy(current, now) !== owed) return { reject: 'moved' };
      return { state: actInRound(current, ix.userId, { amount: total, proposal: raise }) };
    },
    { allow: ['playing'] },
  );
  if (!proposed.ok) {
    await giveBack(ctx.db, table, ix.userId, total);
    return reply({ content: 'ほかの人が先に動きました。開き直してください。' });
  }

  const note = raise < wanted ? `（全員が払える ${raise} まで下げました）` : '';
  return afterBetStep(
    ix,
    ctx,
    table,
    settings,
    em,
    `${coins(raise, settings)} のレイズを提案しました${note}。合計 ${coins(total, settings)} 出しています。`,
  );
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
    ({ table, state }) => {
      if (state.phase !== 'draw' || !everyoneExchanged(state)) return { reject: 'wait' };
      return { state: toBetPhase(state, table.bet) };
    },
    { allow: ['playing'] },
  );
  if (toBet.ok) return;

  // 周が終わっていれば閉じる。閉じた結果 phase が done になったら役比べへ
  const closed = await mutate(
    ctx.db,
    id,
    ({ state }) => {
      if (state.phase !== 'bet') return { reject: 'wait' };
      if (state.step === PROPOSE) {
        if (!proposeRoundOver(state)) return { reject: 'wait' };
        const next = closeProposeRound(state);
        return next.phase === 'done' ? { state: next, status: 'done' } : { state: next };
      }
      if (!acceptRoundOver(state)) return { reject: 'wait' };
      const next = closeAcceptRound(state);
      return next.phase === 'done' ? { state: next, status: 'done' } : { state: next };
    },
    { allow: ['playing'] },
  );
  if (!closed.ok) return;

  // まだ勝負が続くなら、次の周の掲示は呼び出し側が描き直す
  if (closed.state.phase !== 'done') return;

  const toDone = closed;
  const result = await settleTable(ctx.db, toDone.table, toDone.state);
  ctx.waitUntil(
    (async () => {
      const table = await getTable(ctx.db, id);
      if (!table?.message_id) return;
      await ctx.rest
        .editMessage(table.channel_id, table.message_id, resultPayload(table, toDone.state, result, settings, em))
        .catch((error) => console.error('簡ポーカーの結果表示に失敗:', error));
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
    .catch((error) => console.error('簡ポーカーの卓の更新に失敗:', error));
}

/* ------------------------------------------------------------------ 表示 */

function lobbyPayload(table, state, settings) {
  const seats = state.players.map((player) => `　<@${player.userId}>`).join('\n') || '　（まだ誰もいません）';
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `♠️ 簡ポーカー　参加費 ${table.bet}`,
        description:
          `<@${table.host_id}> が卓を立てました。**${MIN_PLAYERS}〜${MAX_PLAYERS}人**で遊べます。\n\n` +
          `5枚配って、いらない札を**${MAX_DRAWS}回まで**引き直し。\n` +
          'そのあと「乗る」「レイズを提案」「降りる」。誰も提案しなくなったら役比べです。\n\n' +
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
  const lines = state.players.map((player) => {
    const draws = player.draws ?? 0;
    const mark = player.exchanged ? '✅ 交換ずみ' : draws > 0 ? `🔁 ${draws}回替えた` : '⏳ 考え中…';
    return `　<@${player.userId}>　${mark}`;
  });
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: '♠️ 簡ポーカー　札の交換',
        description:
          '**手札は本人にだけ見えます。** 下のボタンから開いて、いらない札を引き直してください。\n\n' +
          lines.join('\n'),
        fields: [{ name: '場', value: coins(potOf(state), settings), inline: true }],
        footer: { text: `${MAX_DRAWS}回まで、毎回5枚まで替えられます` },
      }),
    ],
    components: [row(button(`pk:hand:${table.id}`, '手札を見る', { emoji: '🃏', style: ButtonStyle.PRIMARY }))],
  };
}

/**
 * 勝負の段階のボタン。
 *   承認の周 … 承認する／降りる
 *   提案の周 … 乗る（または このまま）／降りる／レイズ3つ
 * 掲示のボタンは人によって払う額が違うので、数字を出さない（mine のときだけ出す）。
 */
function betRows(table, state, { owed = null, mine = false } = {}) {
  if (state.step === ACCEPT) {
    return [
      row(
        button(`pk:call:${table.id}`, mine && owed ? `承認する（+${owed}）` : '承認する', {
          emoji: '🤝',
          style: ButtonStyle.SUCCESS,
        }),
        button(`pk:fold:${table.id}`, '降りる', { emoji: '🏳️', style: ButtonStyle.SECONDARY }),
      ),
    ];
  }

  // 出すものが無い周は「このまま」。降りても得がないので出さない
  const settled = mine && owed === 0;
  const first = [
    button(`pk:call:${table.id}`, settled ? 'このまま' : mine ? `乗る（+${owed}）` : '乗る', {
      emoji: settled ? '✅' : '💪',
      style: settled ? ButtonStyle.PRIMARY : ButtonStyle.SUCCESS,
    }),
  ];
  if (!settled) first.push(button(`pk:fold:${table.id}`, '降りる', { emoji: '🏳️', style: ButtonStyle.SECONDARY }));

  const half = Math.max(1, Math.floor(table.bet / 2));
  return [
    row(...first),
    row(
      button(`pk:raise:${table.id}:half`, `レイズ +${half}`, { emoji: '📈', style: ButtonStyle.PRIMARY }),
      button(`pk:raise:${table.id}:same`, `レイズ +${table.bet}`, { emoji: '📈', style: ButtonStyle.PRIMARY }),
      button(`pk:raiseform:${table.id}`, '好きな額', { emoji: '✏️', style: ButtonStyle.PRIMARY }),
    ),
  ];
}

function betPayload(table, state, settings) {
  const accepting = state.step === ACCEPT;
  const lines = state.players.map((player) => {
    if (player.folded) return `　<@${player.userId}>　🏳️ 降りた`;
    if (accepting) {
      return `　<@${player.userId}>　${owedBy(state, player) === 0 ? '🤝 承認した' : '⏳ 考え中…'}`;
    }
    if (!player.acted) return `　<@${player.userId}>　⏳ 考え中…`;
    return player.proposal > 0
      ? `　<@${player.userId}>　📈 +${player.proposal} を提案`
      : `　<@${player.userId}>　✅ 乗った`;
  });

  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: accepting ? '♠️ 簡ポーカー　レイズが出た！' : '♠️ 簡ポーカー　勝負',
        description:
          (accepting
            ? `**+${state.lastRaise}** のレイズが通りました。1人あたり **${state.level}** までです。\n` +
              '承認するか、降りるかを決めてください。\n\n'
            : `1人あたり **${state.level}**。レイズを提案すると、全員に承認するか降りるかを聞きます。\n` +
              '誰も提案しなければ、ここで役比べです。\n\n') + lines.join('\n'),
        fields: [{ name: '場', value: coins(potOf(state), settings), inline: true }],
        footer: { text: accepting ? '手札を見てから決められます' : '何度でもレイズできます' },
      }),
    ],
    components: [
      row(button(`pk:hand:${table.id}`, '手札を見る', { emoji: '🃏', style: ButtonStyle.PRIMARY })),
      ...betRows(table, state),
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
          title: '⌛ 簡ポーカーは流れました',
          description: '時間切れです。預かっていた参加費は全員に返しました。',
        }),
      ],
      components: [],
    },
  };
}

