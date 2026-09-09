/**
 * チャージ＆シュート（1対1）。
 * 二人が同時に手を選び、そろったところで結果を出す。
 */
import { MAX_HP, MAX_ROUNDS, MOVES, canUse, hearts, playRound } from '../lib/charge.js';
import { finishDuel, mutate, otherRole, refundDuel, settleDuel, userIdOf } from '../lib/duel.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { EMOJI as em } from '../lib/emoji.js';

export const key = 'cs';
export const title = 'チャージ＆シュート';
export const emojiSlot = 'charge';
export const color = 0xf1c40f;

export function inviteFields() {
  return [{ name: 'ルール', value: RULES }];
}

const RULES = [
  `二人**同時**に手を選びます。体力は **${MAX_HP}**、**${MAX_HP}回撃たれたら負け**です。`,
  '',
  `${MOVES.charge.emoji} **ためる** — エネルギー+1。ただし無防備`,
  `${MOVES.guard.emoji} **ガード** — シュートを防ぐ`,
  `${MOVES.shoot.emoji} **シュート** — エネルギー1。ためている相手に当たる`,
  '',
  'シュートどうしは相殺。ガードにも防がれます。',
].join('\n');

export async function start(ctx, { duel, settings }) {
  const state = {
    hp: { challenger: MAX_HP, opponent: MAX_HP },
    energy: { challenger: 0, opponent: 0 },
    choice: { challenger: null, opponent: null },
    round: 1,
    log: [],
  };
  const started = await mutate(ctx.db, duel.id, () => ({ state }));
  if (!started.ok) return { content: '', embeds: [embed({ description: '開始できませんでした。' })], components: [] };
  return board(started.duel, state, settings, '勝負開始！ 二人とも手を選んでください。');
}

export async function handle(ix, ctx, { duel, role, action, args }) {
  if (action !== 'move') return reply({ content: '不明な操作です。' });
  const move = args[0];
  if (!MOVES[move]) return reply({ content: '不明な手です。' });

  const settings = await ctx.settings(duel.guild_id);

  // 自分の手を入れる。相手と同時に押されてもやり直して必ず入る
  const chosen = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.choice[role]) return { reject: 'already' };
    if (!canUse(move, state.energy[role])) return { reject: 'energy' };
    return { state: { ...state, choice: { ...state.choice, [role]: move } } };
  });

  if (!chosen.ok) {
    const messages = {
      already: 'もう手を選んでいます。相手を待ってください。',
      energy: 'エネルギーが足りません。',
      closed: 'この勝負はもう終わっています。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[chosen.reason] ?? '選べませんでした。' });
  }

  const state = chosen.state;
  // まだ相手が選んでいなければ、自分にだけ知らせて待つ
  if (!state.choice.challenger || !state.choice.opponent) {
    return reply({
      content: `${MOVES[move].emoji} **${MOVES[move].label}** を選びました。相手を待っています…`,
    });
  }

  return resolveRound(ix, ctx, chosen.duel, state, settings);
}

/** 二人そろったので、1ラウンド進める。 */
async function resolveRound(ix, ctx, duel, state, settings) {
  const round = playRound(state.hp, state.energy, state.choice);
  const entry = {
    round: state.round,
    moves: { ...state.choice },
    reason: round.reason,
    damaged: round.damaged,
  };
  const log = [...state.log, entry].slice(-6);
  const winner = round.loser ? otherRole(round.loser) : null;

  if (winner) {
    const next = { ...state, hp: round.hp, energy: round.energy, choice: { challenger: null, opponent: null }, log };
    if (!(await finishDuel(ctx.db, duel, next))) return reply({ content: 'この勝負はもう終わっています。' });
    const { pot } = await settleDuel(ctx.db, duel, winner);
    ctx.animate(ix, [{ after: 1000, payload: resultPayload(duel, entry, next, settings, winner, pot) }]);
    return update(revealFrame(duel, entry));
  }

  const drawn = state.round >= MAX_ROUNDS;
  const next = {
    ...state,
    hp: round.hp,
    energy: round.energy,
    choice: { challenger: null, opponent: null },
    round: state.round + 1,
    log,
  };

  if (drawn) {
    if (!(await finishDuel(ctx.db, duel, next))) return reply({ content: 'この勝負はもう終わっています。' });
    await refundDuel(ctx.db, duel);
    ctx.animate(ix, [{ after: 1000, payload: drawPayload(duel, settings) }]);
    return update(revealFrame(duel, entry));
  }

  const moved = await mutate(ctx.db, duel.id, () => ({ state: next }));
  if (!moved.ok) return reply({ content: 'この勝負はもう終わっています。' });

  const headline = round.damaged
    ? `💥 **${round.reason}！** <@${userIdOf(duel, round.damaged)}> に命中！`
    : `**${round.reason}**`;
  ctx.animate(ix, [{ after: 1000, payload: board(moved.duel, next, settings, headline) }]);
  return update(revealFrame(duel, entry));
}

/** 出した手を見せる一瞬。 */
function revealFrame(duel, entry) {
  return {
    content: '',
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description:
          `**第${entry.round}ラウンド**\n\n` +
          `<@${duel.challenger_id}>　${MOVES[entry.moves.challenger].emoji} ${MOVES[entry.moves.challenger].label}\n` +
          `<@${duel.opponent_id}>　${MOVES[entry.moves.opponent].emoji} ${MOVES[entry.moves.opponent].label}`,
      }),
    ],
    components: [],
  };
}

export function board(duel, state, settings, headline = null) {
  const waiting = [];
  if (!state.choice.challenger) waiting.push(duel.challenger_id);
  if (!state.choice.opponent) waiting.push(duel.opponent_id);

  const history = state.log
    .slice(-4)
    .map((entry) => {
      const mark = entry.damaged ? '💥' : '・';
      return `${mark} 第${entry.round}R ${MOVES[entry.moves.challenger].emoji} vs ${MOVES[entry.moves.opponent].emoji} — ${entry.reason}`;
    })
    .join('\n');

  return {
    content: waiting.map((userId) => `<@${userId}>`).join(' '),
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description:
          (headline ? `${headline}\n\n` : '') +
          `**第${state.round}ラウンド** — 二人とも手を選んでください。\n` +
          (history ? `\n${history}` : ''),
        fields: [
          {
            name: '挑戦者',
            value: fighter(duel.challenger_id, state.hp.challenger, state.energy.challenger, state.choice.challenger),
            inline: true,
          },
          {
            name: '相手',
            value: fighter(duel.opponent_id, state.hp.opponent, state.energy.opponent, state.choice.opponent),
            inline: true,
          },
          { name: '勝てば', value: coins(duel.escrow * 2, settings), inline: true },
        ],
        footer: { text: `${MAX_ROUNDS}ラウンドで決着がつかなければ引き分け（返金）` },
      }),
    ],
    components: moveRows(duel),
    allowed_mentions: { users: waiting },
  };
}

function fighter(userId, hp, energy, chosen) {
  const bar = energy > 0 ? '⚡'.repeat(Math.min(energy, 6)) : '—';
  return `<@${userId}>\n${hearts(hp)}\n${bar} (${energy})${chosen ? '\n✅ 手を選びました' : ''}`;
}

/**
 * 手のボタン。
 * どちらのプレイヤーも押せるので、エネルギーが足りるかは押されたときに見る
 * （二人でエネルギーが違うため、ボタンの有効・無効では表せない）。
 */
function moveRows(duel) {
  return [
    row(
      ...Object.entries(MOVES).map(([move, meta]) =>
        button(`d:move:${duel.id}:${move}`, meta.label, {
          emoji: meta.emoji,
          style: move === 'shoot' ? ButtonStyle.DANGER : ButtonStyle.SECONDARY,
        }),
      ),
    ),
  ];
}

function resultPayload(duel, entry, state, settings, winner, pot) {
  const winnerId = userIdOf(duel, winner);
  const loserId = userIdOf(duel, otherRole(winner));
  return {
    content: '',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${em[emojiSlot]} ${title} 決着`,
        description:
          `<@${duel.challenger_id}>　${MOVES[entry.moves.challenger].emoji} ${MOVES[entry.moves.challenger].label}\n` +
          `<@${duel.opponent_id}>　${MOVES[entry.moves.opponent].emoji} ${MOVES[entry.moves.opponent].label}\n\n` +
          `**${entry.reason}**\n\n` +
          `<@${duel.challenger_id}> ${hearts(state.hp.challenger)}　/　<@${duel.opponent_id}> ${hearts(state.hp.opponent)}\n\n` +
          `🏆 **<@${winnerId}> の勝ち！** ${coins(pot, settings)} を総取りしました。`,
      }),
    ],
    components: [],
    allowed_mentions: { users: [winnerId, loserId] },
  };
}

function drawPayload(duel, settings) {
  return {
    content: '',
    embeds: [
      embed({
        color: 0x95a5a6,
        title: `${em[emojiSlot]} ${title} 引き分け`,
        description: `${MAX_ROUNDS}ラウンド戦っても決着がつきませんでした。賭け金はそれぞれ返しました。`,
      }),
    ],
    components: [],
  };
}
