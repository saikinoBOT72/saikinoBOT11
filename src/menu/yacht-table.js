/**
 * ヨットの画面。
 *
 * 【隠し方】
 * 公開の掲示に出すのは「何欄書いたか」と「いまの合計」だけ。
 * 出目とスコアカードの中身は、「カードを開く」を押した本人にしか出さない。
 *
 * 【13欄をどう選ばせるか】
 * ボタンは1メッセージに25個までしか置けないので、記入先はセレクトメニューにした。
 * まだ空いている欄だけを、**いまの出目で何点になるか付きで**並べる。
 * これなら数えなくても選べるし、0点で捨てる欄も一目で分かる。
 *
 * 【ひとり練習】
 * 参加費0の卓。チャンネルには何も出さず、本人のメニュー画面だけで進む。
 */
import {
  MAX_PLAYERS,
  MAX_ROLLS,
  MIN_PLAYERS,
  canRoll,
  canWrite,
  createTable,
  everyoneDone,
  getTable,
  joinTable,
  mutate,
  neededPlayers,
  playerOf,
  potOf,
  recordScore,
  refundTable,
  rollFor,
  seatOf,
  setMessageId,
  setStatus,
  settleTable,
  standings,
  stateOf,
  toggleKeep,
  writeScore,
} from '../lib/yacht-table.js';
import { CATEGORIES, CATEGORY_BY_KEY, openCategories, scoreFor, tally } from '../lib/yacht.js';
import { getSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row, stringSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { diceFaces } from '../lib/emoji.js';

/** 公開メッセージのボタンは `yt:` 始まり。 */
export const namespace = 'yt';

const COLOR = 0x16a085;

/* ------------------------------------------------------------------ 卓を立てる */

/**
 * 卓をチャンネルに出す。
 *
 * 【ひとり練習でも必ず出す理由】
 * 「あなただけに表示されています」のメッセージは自分で消せてしまう。
 * それだけで進めていると、うっかり消した時点で続きが開けなくなる。
 * チャンネルに残る掲示を必ず1枚置いて、そこの「カードを開く」から
 * いつでも戻れるようにしておく。
 */
async function postBoard(ctx, id, payload) {
  const message = await ctx.rest.createMessage((await getTable(ctx.db, id)).channel_id, payload);
  await setMessageId(ctx.db, id, message.id);
  return message;
}

export async function openTable(ctx, { guildId, channelId, hostId, bet, settings }) {
  const id = crypto.randomUUID();
  await createTable(ctx.db, { id, guildId, channelId, hostId, bet });

  const joined = await joinTable(ctx.db, await getTable(ctx.db, id), hostId);
  if (!joined.ok) {
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: joined.reason };
  }

  try {
    const message = await postBoard(ctx, id, lobbyPayload(await getTable(ctx.db, id), joined.state, settings));
    return { ok: true, message, table: await getTable(ctx.db, id) };
  } catch (error) {
    console.error('ヨットの卓の投稿に失敗:', error);
    await refundTable(ctx.db, await getTable(ctx.db, id), joined.state);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }
}

/**
 * ひとり練習を始める。
 * 人を待つ必要がないので、掲示は最初から「記入中」の形で出す
 * （募集中の画面が一瞬ちらつかないように、立てて・座って・始めてから出す）。
 */
export async function startSolo(ctx, { guildId, channelId, userId, settings }) {
  const id = crypto.randomUUID();
  await createTable(ctx.db, { id, guildId, channelId, hostId: userId, bet: 0 });

  const joined = await joinTable(ctx.db, await getTable(ctx.db, id), userId);
  if (!joined.ok) {
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: joined.reason };
  }

  const started = await mutate(ctx.db, id, ({ state }) => ({ state, status: 'playing' }), {
    allow: ['joining'],
  });
  if (!started.ok) {
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'start' };
  }

  try {
    await postBoard(ctx, id, boardPayload(started.table, started.state, settings));
  } catch (error) {
    console.error('ヨットのひとり練習の投稿に失敗:', error);
    await setStatus(ctx.db, id, 'cancelled');
    return { ok: false, reason: 'post' };
  }

  const table = await getTable(ctx.db, id);
  return { ok: true, payload: cardPayload(table, stateOf(table), userId, await ctx.emoji()) };
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
  if (action === 'join') return handleJoin(ix, ctx, table, settings);
  if (action === 'start') return handleStart(ix, ctx, table, settings);

  const em = await ctx.emoji();
  if (action === 'card') return handleCard(ix, table, em);
  if (action === 'roll') return handleRoll(ix, ctx, table, settings, em);
  if (action === 'keep') return handleKeep(ix, ctx, table, Number(arg), em);
  if (action === 'write') return handleWrite(ix, ctx, table, settings, em);
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 座る・始める */

async function handleJoin(ix, ctx, table, settings) {
  if (table.status !== 'joining') {
    return update(boardPayload(table, stateOf(table), settings));
  }

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
  const need = neededPlayers(table);
  if (stateOf(table).players.length < need) {
    return reply({ content: `${need}人集まらないと始められません。` });
  }

  const started = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (state.players.length < need) return { reject: 'few' };
      return { state, status: 'playing' };
    },
    { allow: ['joining'] },
  );
  const fresh = started.ok ? started.table : await getTable(ctx.db, table.id);
  return update(boardPayload(fresh, stateOf(fresh), settings));
}

/* ------------------------------------------------------------------ カード（本人だけ） */

async function handleCard(ix, table, em) {
  const state = stateOf(table);
  if (seatOf(state, ix.userId) < 0) return reply({ content: 'この卓に座っていません。' });
  return reply(cardPayload(table, state, ix.userId, em));
}

async function handleRoll(ix, ctx, table, settings, em) {
  const rolled = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (player.done) return { reject: 'done' };
      if (!canRoll(player)) return { reject: 'norolls' };
      return { state: rollFor(state, ix.userId) };
    },
    { allow: ['playing'] },
  );
  if (!rolled.ok) {
    const messages = { norolls: `振れるのは${MAX_ROLLS}回までです。どこに書くか選んでください。`, done: 'もう書き終えています。' };
    return reply({ content: messages[rolled.reason] ?? '振れませんでした。' });
  }

  ctx.waitUntil(refreshBoard(ctx, rolled.table, settings));
  return update(cardPayload(rolled.table, rolled.state, ix.userId, em));
}

async function handleKeep(ix, ctx, table, index, em) {
  const moved = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (player.rolls === 0 || player.done) return { reject: 'early' };
      if (!Number.isInteger(index) || index < 0 || index >= player.dice.length) return { reject: 'range' };
      return { state: toggleKeep(state, ix.userId, index) };
    },
    { allow: ['playing'] },
  );
  if (!moved.ok) return reply({ content: 'まず振ってください。' });
  return update(cardPayload(moved.table, moved.state, ix.userId, em));
}

async function handleWrite(ix, ctx, table, settings, em) {
  const key = ix.values?.[0];
  if (!CATEGORY_BY_KEY[key]) return reply({ content: '不明な記入先です。' });

  const written = await mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      const player = playerOf(state, ix.userId);
      if (!player) return { reject: 'seat' };
      if (player.done) return { reject: 'done' };
      if (!canWrite(player)) return { reject: 'early' };
      if (player.card[key] != null) return { reject: 'used' };
      return { state: writeScore(state, ix.userId, key) };
    },
    { allow: ['playing'] },
  );
  if (!written.ok) {
    const messages = { early: 'まず振ってください。', used: 'その欄はもう書いてあります。', done: 'もう書き終えています。' };
    return reply({ content: messages[written.reason] ?? '書けませんでした。' });
  }

  const me = playerOf(written.state, ix.userId);
  if (me.done) await recordScore(ctx.db, table.guild_id, ix.userId, tally(me.card).total);

  // 全員書き終えたら決着。まだなら掲示だけ更新して自分のカードに戻る
  if (everyoneDone(written.state)) return finish(ctx, written.table, written.state, settings);

  ctx.waitUntil(refreshBoard(ctx, written.table, settings));
  return update(cardPayload(written.table, written.state, ix.userId, em));
}

/** 全員が書き終えた。精算して結果を出す。 */
async function finish(ctx, table, state, settings) {
  const done = await mutate(ctx.db, table.id, ({ state: now }) => ({ state: now, status: 'done' }), {
    allow: ['playing'],
  });
  if (!done.ok) {
    return update(resultPayload(table, { ranked: standings(state), winners: [], pot: 0 }, settings));
  }

  const result = await settleTable(ctx.db, table, state);
  const payload = resultPayload(table, result, settings);

  // 卓ならチャンネルの掲示を結果に差し替える。ひとり練習は本人の画面だけ
  if (table.message_id) {
    ctx.waitUntil(
      ctx.rest
        .editMessage(table.channel_id, table.message_id, payload)
        .catch((error) => console.error('ヨットの結果表示に失敗:', error)),
    );
  }
  // ひとり練習は自分しかいないので、結果をそのまま手元にも出す
  return update(table.bet > 0 ? finishedPayload(result) : payload);
}

/** 公開の掲示を、いまの進み具合で描き直す。 */
async function refreshBoard(ctx, table, settings) {
  if (!table?.message_id) return;
  const state = stateOf(table);
  if (table.status === 'done') return;
  await ctx.rest
    .editMessage(table.channel_id, table.message_id, boardPayload(table, state, settings))
    .catch((error) => console.error('ヨットの卓の更新に失敗:', error));
}

/* ------------------------------------------------------------------ 表示 */

/**
 * 全員ぶんのスコアボードを1つの表にする。
 *
 * 【なぜコードブロックに入れるのか】
 * 数字の桁をそろえないと表として読めない。Discord で桁をそろえられるのは
 * コードブロック（等幅）の中だけ。ただしコードブロックの中では <@id> が
 * 名前に変わらないので、**名前は表の外に並べて番号で対応させる**。
 *
 * 【全員に見せる理由】
 * 本物のヨットもスコアシートは全員に見えている。相手が何を空けているかが
 * 見えるからこそ「ここで大ストレートを捨てるか」という判断が生まれる。
 * 隠すのは、いま振っている出目だけでよい。
 */

/** 見た目の幅（全角は2、半角は1）。 */
function displayWidth(text) {
  return [...text].reduce((total, char) => total + (/[\u0020-\u007e]/.test(char) ? 1 : 2), 0);
}

const padRight = (text, target) => text + ' '.repeat(Math.max(0, target - displayWidth(text)));
const padLeft = (text, target) => ' '.repeat(Math.max(0, target - displayWidth(text))) + text;

const LABEL_WIDTH = 9;
const COLUMN_WIDTH = 5;

/**
 * 書いていない欄は「-」、書いた欄は数字（0点でも 0 と出す）。
 * 半角の「-」を使うのは、桁をそろえる計算が半角1文字ぶんで済むから
 * （「−」などの記号は等幅フォントでも幅が読みきれず、表がずれる）。
 */
const cell = (value) => (value == null ? '-' : String(value));

function scoreboard(state, meId) {
  const players = state.players;
  const columns = players.map((_, index) => String(index + 1));

  const header = padRight('', LABEL_WIDTH) + columns.map((name) => padLeft(name, COLUMN_WIDTH)).join('');
  const rowFor = (label, values) =>
    padRight(label, LABEL_WIDTH) + values.map((value) => padLeft(value, COLUMN_WIDTH)).join('');

  const lines = [header];
  for (const category of CATEGORIES) {
    if (category.key === 'three') {
      // 上段と下段のあいだに小計とボーナスを挟む
      lines.push(rowFor('小計', players.map((player) => String(tally(player.card).upper))));
      lines.push(
        rowFor('ボーナス', players.map((player) => {
          const counted = tally(player.card);
          return counted.bonus > 0 ? `+${counted.bonus}` : '-';
        })),
      );
      lines.push('');
    }
    lines.push(rowFor(category.short, players.map((player) => cell(player.card[category.key]))));
  }
  lines.push('');
  lines.push(rowFor('合計', players.map((player) => String(tally(player.card).total))));

  const legend = players
    .map((player, index) => `**${index + 1}** <@${player.userId}>${player.userId === meId ? '（あなた）' : ''}`)
    .join('　／　');

  return `${legend}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/**
 * サイコロ1個ぶんのボタン。
 * サーバーにサイコロの絵文字が入っていればそれをボタンに載せ、
 * 入っていなければ ⚀〜⚅ をラベルに出す（⚀〜⚅ は Unicode の絵文字ではないので
 * ボタンの emoji には載せられない。載せると Discord がメッセージごと弾く）。
 */
function keepButton(tableId, faces, die, keep, index) {
  const face = faces[die];
  const custom = /^<a?:\w+:\d+>$/.test(face);
  return button(
    `yt:keep:${tableId}:${index}`,
    custom ? (keep ? '残' : '捨') : `${face} ${keep ? '残' : '捨'}`,
    {
      emoji: custom ? face : undefined,
      style: keep ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY,
    },
  );
}

/** 本人にだけ見えるカード。出目は本人だけ、スコアボードは全員ぶん。 */
function cardPayload(table, state, userId, em, notice = null) {
  const player = playerOf(state, userId);
  const faces = diceFaces(em);
  const counted = tally(player.card);
  const written = CATEGORIES.length - openCategories(player.card).length;

  const head =
    player.rolls === 0
      ? '**振ってください。**'
      : `${player.dice.map((die, index) => (player.keep[index] ? `**[${faces[die]}]**` : faces[die])).join(' ')}　` +
        `残り **${MAX_ROLLS - player.rolls}回**`;

  const body =
    `${head}\n\n` +
    `${scoreboard(state, userId)}\n` +
    (counted.bonus > 0
      ? `ボーナス **+${counted.bonus}** 獲得`
      : `あと **${counted.toBonus}点** で上段ボーナス **+35**`) +
    `　／　${written}/${CATEGORIES.length} 欄`;

  const components = [];
  if (player.rolls > 0 && !player.done) {
    components.push(
      row(...player.dice.map((die, index) => keepButton(table.id, faces, die, player.keep[index], index))),
    );
  }
  if (!player.done) {
    components.push(
      row(
        button(`yt:roll:${table.id}`, player.rolls === 0 ? '振る' : `振り直す（残り${MAX_ROLLS - player.rolls}）`, {
          emoji: '🎲',
          style: ButtonStyle.PRIMARY,
          disabled: !canRoll(player),
        }),
      ),
    );
    if (canWrite(player)) components.push(writeSelect(table, player));
  }

  return {
    embeds: [
      withNoticeLine(
        embed({
          color: COLOR,
          title: '🎲 スコアボード',
          description: body,
          footer: { text: player.done ? 'ほかの人を待っています' : '残すサイコロを選んでから振り直す' },
        }),
        notice,
      ),
    ],
    components,
  };
}

/** まだ空いている欄を「いま書いたら何点か」付きで並べる。 */
function writeSelect(table, player) {
  const options = openCategories(player.card).map((category) => {
    const points = scoreFor(category.key, player.dice);
    return {
      label: `${category.name} … ${points}点`,
      value: category.key,
      description: points === 0 ? `0点で捨てる（${category.hint}）` : category.hint,
    };
  });
  return stringSelect(`yt:write:${table.id}`, 'どこに書く？', options);
}

function withNoticeLine(embedObject, notice) {
  if (!notice) return embedObject;
  return { ...embedObject, description: `${notice}\n\n${embedObject.description}` };
}

/** 決着したあと、押した本人に返す短い知らせ。結果そのものは掲示に出す。 */
function finishedPayload(result) {
  return {
    embeds: [
      embed({
        color: COLOR,
        title: '🎲 書き終えました',
        description: `結果はチャンネルの掲示に出ています。\n一番高かったのは **${result.ranked[0]?.total ?? 0}点**。`,
      }),
    ],
    components: [],
  };
}

function lobbyPayload(table, state, settings) {
  const seats = state.players.map((player) => `　<@${player.userId}>`).join('\n') || '　（まだ誰もいません）';
  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: `🎲 ヨット　参加費 ${table.bet}`,
        description:
          `<@${table.host_id}> が卓を立てました。**${MIN_PLAYERS}〜${MAX_PLAYERS}人**で遊べます。\n\n` +
          `参加費は ${coins(table.bet, settings)}。サイコロ5個を **${MAX_ROLLS}回まで** 振り直して役を作り、\n` +
          '**13個の欄**を1つずつ埋めます。\n' +
          '全員が同時に進めるので、順番待ちはありません。合計点が一番高い人が総取り。\n\n' +
          `**席（${state.players.length}/${MAX_PLAYERS}）**\n${seats}`,
        footer: { text: '2分以内に始まらなければ流れます' },
      }),
    ],
    components: [
      row(
        button(`yt:join:${table.id}`, '座る', { emoji: '👋', style: ButtonStyle.SUCCESS }),
        button(`yt:start:${table.id}`, '始める（親）', {
          emoji: '▶️',
          style: ButtonStyle.PRIMARY,
          disabled: state.players.length < neededPlayers(table),
        }),
      ),
    ],
  };
}

/** 進み具合だけを出す掲示。中身は出さない。 */
function boardPayload(table, state, settings) {
  if (table.status === 'joining') return lobbyPayload(table, state, settings);

  const lines = state.players.map((player) => {
    const counted = tally(player.card);
    const written = CATEGORIES.length - openCategories(player.card).length;
    const mark = player.done ? '✅' : '⏳';
    return `　${mark} <@${player.userId}>　${written}/${CATEGORIES.length} 欄　**${counted.total}点**`;
  });

  return {
    content: '',
    embeds: [
      embed({
        color: COLOR,
        title: table.bet > 0 ? '🎲 ヨット　記入中' : '🎲 ヨット　ひとり練習',
        description:
          '**いま振っている出目は本人にしか見えません。** 下のボタンから開いてください。\n' +
          (table.bet > 0 ? '全員が同時に進められます。順番待ちはありません。\n\n' : '賭けなしの練習です。自己ベストだけ記録されます。\n\n') +
          lines.join('\n'),
        fields: table.bet > 0 ? [{ name: '場', value: coins(potOf(table, state), settings), inline: true }] : [],
        footer: { text: `サイコロ5個・${MAX_ROLLS}回まで振り直し・13欄` },
      }),
    ],
    components: [
      row(button(`yt:card:${table.id}`, 'カードを開く', { emoji: '🎲', style: ButtonStyle.PRIMARY })),
    ],
  };
}

function resultPayload(table, result, settings) {
  const best = result.ranked[0]?.total ?? 0;
  const lines = result.ranked.map((entry, index) => {
    const crown = entry.total === best ? '　👑' : '';
    const bonus = entry.bonus > 0 ? `（上段${entry.upper}＋ボーナス35）` : `（上段${entry.upper}）`;
    return `　${index + 1}. <@${entry.userId}>　**${entry.total}点** ${bonus}${crown}`;
  });

  const verdict =
    result.pot === 0
      ? `**${best}点** でした。`
      : result.winners.length === 1
        ? `**<@${result.winners[0].userId}> の勝ち！** ${coins(result.pot, settings)} を総取り`
        : `**引き分け**。${result.winners.map((winner) => `<@${winner.userId}>`).join(' と ')} で山分け`;

  return {
    content: '🎲🎲🎲🎲🎲',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `🏆 ${best}点`,
        description: `${verdict}\n\n${lines.join('\n')}`,
        footer: { text: result.pot > 0 ? `参加費 ${table.bet}` : 'ひとり練習' },
      }),
    ],
    components: result.pot > 0
      ? [againRow(table)]
      : [row(button('m:yt:solo', 'もう一度ひとりで', { emoji: '🎲', style: ButtonStyle.SUCCESS }))],
  };
}

function againRow(table) {
  return row(
    button(`yt:again:${table.id}`, `もう一度（${table.bet}）`, { emoji: '🔁', style: ButtonStyle.SUCCESS }),
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

/** 1分ごとの見回りから呼ばれる。預かったぶんを返して流す。 */
export async function timeOut(ctx, table) {
  const state = stateOf(table);
  await refundTable(ctx.db, table, state);
  await setStatus(ctx.db, table.id, 'cancelled');
  if (!table.message_id) return null; // ひとり練習は掲示がない
  return {
    payload: {
      content: '',
      embeds: [
        embed({
          color: 0x95a5a6,
          title: '⌛ ヨットは流れました',
          description: '時間切れです。預かっていた参加費は全員に返しました。',
        }),
      ],
      components: [],
    },
  };
}
