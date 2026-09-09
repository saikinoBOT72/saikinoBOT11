/**
 * 地雷設置＆陣取りバトル（1対1）。
 * 先に2つずつ地雷を埋め、そのあと交互にマスを取り合う。
 */
import {
  CELLS,
  MINES_PER_PLAYER,
  SIZE,
  bothReady,
  claim,
  countOwned,
  emptyBoard,
  isOver,
  leader,
  placeMine,
} from '../lib/mines.js';
import { finishDuel, mutate, otherRole, randomFirst, settleDuel, userIdOf } from '../lib/duel.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

export const key = 'mine';
export const title = '地雷＆陣取り';
export const emojiSlot = 'mines';
export const color = 0x34495e;

const MARKS = { challenger: '🟥', opponent: '🟦', null: '⬜' };
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

export function inviteFields() {
  return [{ name: 'ルール', value: RULES }];
}

const RULES = [
  `3×3 の9マス。まず二人が**こっそり${MINES_PER_PLAYER}つずつ地雷を埋めます**。`,
  '',
  'そのあと交互にマスを取ります。',
  '・何もないマス → **自分の陣地**',
  '・**相手の地雷** → 爆発して、そのマスは**相手の陣地**に',
  '・自分の地雷は不発（ふつうに自分の陣地）',
  '',
  '9マス埋まった時点で、**多く取ったほうの勝ち**。',
].join('\n');

export async function start(ctx, { duel, settings, em }) {
  const state = {
    phase: 'place',
    board: emptyBoard(),
    mines: { challenger: [], opponent: [] },
    first: randomFirst(),
    log: [],
  };
  const started = await mutate(ctx.db, duel.id, () => ({ state }));
  if (!started.ok) return { content: '', embeds: [embed({ description: '開始できませんでした。' })], components: [] };
  return board(started.duel, state, settings, em, '地雷を埋めるところから始めます。');
}

export async function handle(ix, ctx, { duel, role, action, args }) {
  const cell = Number(args[0]);
  if (action !== 'cell' || !Number.isInteger(cell)) return reply({ content: '不明な操作です。' });

  const settings = await ctx.settings(duel.guild_id);
  const em = await ctx.emoji(duel.guild_id);
  const state = JSON.parse(duel.state);

  if (state.phase === 'place') return handlePlace(ix, ctx, duel, role, cell, settings, em);
  return handleClaim(ix, ctx, duel, role, cell, settings, em);
}

/* ------------------------------------------------------------------ 地雷を埋める */

async function handlePlace(ix, ctx, duel, role, cell, settings, em) {
  const placed = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.phase !== 'place') return { reject: 'phase' };
    const result = placeMine(state.mines[role], cell);
    if (!result.ok) return { reject: result.reason };

    const mines = { ...state.mines, [role]: result.mines };
    const ready = bothReady(mines);
    return {
      state: {
        ...state,
        mines,
        phase: ready ? 'claim' : 'place',
        turn: ready ? state.first : null,
      },
      turn: ready ? state.first : null,
      extra: { ready, count: result.mines.length },
    };
  });

  if (!placed.ok) {
    const messages = {
      duplicate: 'そのマスにはもう埋めています。',
      full: `地雷は${MINES_PER_PLAYER}つまでです。相手を待ってください。`,
      range: 'そのマスはありません。',
      phase: 'もう地雷は埋め終わっています。',
      closed: 'この勝負はもう終わっています。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[placed.reason] ?? '埋められませんでした。' });
  }

  if (!placed.extra.ready) {
    // 相手に見えないよう、埋めた場所は本人にだけ知らせる
    ctx.waitUntil(refreshBoard(ctx, placed.duel, placed.state, settings, em));
    return reply({
      content:
        `${NUMBERS[cell]} に地雷を埋めました（${placed.extra.count}/${MINES_PER_PLAYER}）。` +
        (placed.extra.count < MINES_PER_PLAYER ? '\nもう1つ埋めてください。' : '\n相手が埋め終わるのを待っています…'),
    });
  }

  const firstId = userIdOf(duel, placed.state.first);
  ctx.waitUntil(
    refreshBoard(ctx, placed.duel, placed.state, settings, em, `地雷が出そろいました。先攻は <@${firstId}> です。`),
  );
  return reply({ content: `${NUMBERS[cell]} に地雷を埋めました。勝負開始です！` });
}

/** 公開メッセージのほうを、返事とは別に書き換える。 */
async function refreshBoard(ctx, duel, state, settings, em, headline = null) {
  if (!duel.message_id) return;
  await ctx.rest
    .editMessage(duel.channel_id, duel.message_id, board(duel, state, settings, em, headline))
    .catch((error) => console.error('地雷＆陣取りの盤面更新に失敗:', error));
}

/* ------------------------------------------------------------------ マスを取る */

async function handleClaim(ix, ctx, duel, role, cell, settings, em) {
  const taken = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.phase !== 'claim') return { reject: 'phase' };
    if (state.turn !== role) return { reject: 'turn' };
    if (cell < 0 || cell >= CELLS) return { reject: 'range' };
    if (state.board[cell] !== null) return { reject: 'taken' };

    const outcome = claim(cell, role, state.mines);
    const nextBoard = [...state.board];
    nextBoard[cell] = outcome.owner;
    const log = [...state.log, { cell, role, ...outcome }].slice(-5);
    const over = isOver(nextBoard);

    return {
      state: { ...state, board: nextBoard, turn: over ? null : otherRole(role), log },
      turn: over ? null : otherRole(role),
      extra: { outcome, board: nextBoard, over },
    };
  });

  if (!taken.ok) {
    const messages = {
      turn: 'いまはあなたの番ではありません。',
      taken: 'そのマスはもう取られています。',
      range: 'そのマスはありません。',
      phase: 'まだ地雷を埋める段階です。',
      closed: 'この勝負はもう終わっています。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[taken.reason] ?? '取れませんでした。' });
  }

  const { outcome, over } = taken.extra;
  const headline = outcome.exploded
    ? `💥 <@${ix.userId}> が ${NUMBERS[cell]} で**地雷を踏みました**！ このマスは相手のものに。`
    : `<@${ix.userId}> が ${NUMBERS[cell]} を取りました。`;

  if (!over) {
    return update(board(taken.duel, taken.state, settings, em, headline));
  }

  const winner = leader(taken.state.board);
  if (!(await finishDuel(ctx.db, taken.duel, taken.state))) {
    return reply({ content: 'この勝負はもう終わっています。' });
  }
  const { pot } = await settleDuel(ctx.db, taken.duel, winner);
  return update(resultPayload(duel, taken.state, settings, em, winner, pot, headline));
}

/* ------------------------------------------------------------------ 表示 */

/** 3×3 の盤面。取られたマスは色、空きマスは番号。 */
function grid(state, { reveal = false } = {}) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const cells = [];
    for (let x = 0; x < SIZE; x++) {
      const index = y * SIZE + x;
      const owner = state.board[index];
      if (owner) {
        cells.push(MARKS[owner]);
      } else if (reveal && [...state.mines.challenger, ...state.mines.opponent].includes(index)) {
        cells.push('💣');
      } else {
        cells.push(NUMBERS[index]);
      }
    }
    rows.push(cells.join(' '));
  }
  return rows.join('\n');
}

export function board(duel, state, settings, em, headline = null) {
  const placing = state.phase === 'place';
  const waiting = placing
    ? [duel.challenger_id, duel.opponent_id].filter((_, index) => {
        const role = index === 0 ? 'challenger' : 'opponent';
        return state.mines[role].length < MINES_PER_PLAYER;
      })
    : [userIdOf(duel, state.turn)];

  const description = placing
    ? `${grid(state)}\n\n` +
      (headline ? `${headline}\n\n` : '') +
      `**地雷を${MINES_PER_PLAYER}つずつ埋めてください。**\n` +
      'どのマスに埋めたかは相手には見えません。'
    : `${grid(state)}\n\n` +
      (headline ? `${headline}\n\n` : '') +
      `<@${waiting[0]}> の番です。取るマスを選んでください。`;

  return {
    content: waiting.map((userId) => `<@${userId}>`).join(' '),
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description,
        fields: placing
          ? [
              { name: '挑戦者', value: minesStatus(duel.challenger_id, state.mines.challenger), inline: true },
              { name: '相手', value: minesStatus(duel.opponent_id, state.mines.opponent), inline: true },
              { name: '勝てば', value: coins(duel.escrow * 2, settings), inline: true },
            ]
          : [
              {
                name: '🟥 挑戦者',
                value: `<@${duel.challenger_id}>\n**${countOwned(state.board, 'challenger')}** マス`,
                inline: true,
              },
              {
                name: '🟦 相手',
                value: `<@${duel.opponent_id}>\n**${countOwned(state.board, 'opponent')}** マス`,
                inline: true,
              },
              { name: '勝てば', value: coins(duel.escrow * 2, settings), inline: true },
            ],
      }),
    ],
    components: cellRows(duel, state),
    allowed_mentions: { users: waiting },
  };
}

function minesStatus(userId, mines) {
  return `<@${userId}>\n${'💣'.repeat(mines.length) || '—'} ${mines.length}/${MINES_PER_PLAYER}`;
}

/** 3行×3ボタン。取られたマスは押せない。 */
function cellRows(duel, state) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const buttons = [];
    for (let x = 0; x < SIZE; x++) {
      const index = y * SIZE + x;
      const owner = state.board[index];
      buttons.push(
        button(`d:cell:${duel.id}:${index}`, '​', {
          emoji: owner ? MARKS[owner] : NUMBERS[index],
          style: owner === 'challenger' ? ButtonStyle.DANGER : owner === 'opponent' ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
          disabled: owner !== null,
        }),
      );
    }
    rows.push(row(...buttons));
  }
  return rows;
}

function resultPayload(duel, state, settings, em, winner, pot, headline) {
  const winnerId = userIdOf(duel, winner);
  return {
    content: '',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${em[emojiSlot]} ${title} 決着`,
        description:
          `${grid(state, { reveal: true })}\n\n` +
          `${headline}\n\n` +
          `🟥 <@${duel.challenger_id}> **${countOwned(state.board, 'challenger')}** マス　` +
          `🟦 <@${duel.opponent_id}> **${countOwned(state.board, 'opponent')}** マス\n\n` +
          `🏆 **<@${winnerId}> の勝ち！** ${coins(pot, settings)} を総取りしました。`,
      }),
    ],
    components: [],
    allowed_mentions: { users: [winnerId] },
  };
}
