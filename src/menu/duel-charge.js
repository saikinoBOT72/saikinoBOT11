/**
 * チャージ＆シュート（1対1）。
 * 二人が同時に手を選び、そろったところで結果を出す。
 */
import { MAX_ROUNDS, MOVES, canUse, playRound } from '../lib/charge.js';
import { finishDuel, mutate, refundDuel, settleDuel, userIdOf } from '../lib/duel.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

export const key = 'cs';
export const title = 'チャージ＆シュート';
export const emojiSlot = 'charge';
export const color = 0xf1c40f;

export function inviteFields() {
  return [{ name: 'ルール', value: RULES }];
}

const RULES = [
  '二人**同時**に手を選びます。そろったら結果が出ます。',
  '',
  `${MOVES.charge.emoji} **ためる** — エネルギー+1。ただし無防備`,
  `${MOVES.guard.emoji} **ガード** — シュートを防ぐ。何度でも使える`,
  `${MOVES.shoot.emoji} **シュート** — エネルギー1。ためている相手に当たれば勝ち`,
  `${MOVES.big.emoji} **ビッグシュート** — エネルギー3。**ガードごと撃ち抜く**`,
  '',
  '同じ手どうしは相殺。ビッグはシュートも押し切ります。',
].join('\n');

export async function start(ctx, { duel, settings, em }) {
  const state = {
    energy: { challenger: 0, opponent: 0 },
    choice: { challenger: null, opponent: null },
    round: 1,
    log: [],
  };
  const started = await mutate(ctx.db, duel.id, () => ({ state }));
  if (!started.ok) return { content: '', embeds: [embed({ description: '開始できませんでした。' })], components: [] };
  return board(started.duel, state, settings, em, '勝負開始！ 二人とも手を選んでください。');
}

export async function handle(ix, ctx, { duel, role, action, args }) {
  if (action !== 'move') return reply({ content: '不明な操作です。' });
  const move = args[0];
  if (!MOVES[move]) return reply({ content: '不明な手です。' });

  const settings = await ctx.settings(duel.guild_id);
  const em = await ctx.emoji(duel.guild_id);

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

  return resolveRound(ix, ctx, chosen.duel, state, settings, em);
}

/** 二人そろったので、1ラウンド進める。 */
async function resolveRound(ix, ctx, duel, state, settings, em) {
  const round = playRound(state.energy, state.choice);
  const entry = {
    round: state.round,
    moves: { ...state.choice },
    reason: round.reason,
    winner: round.winner,
  };
  const log = [...state.log, entry].slice(-6);

  if (round.winner) {
    const next = { ...state, energy: round.energy, choice: { challenger: null, opponent: null }, log };
    if (!(await finishDuel(ctx.db, duel, next))) return reply({ content: 'この勝負はもう終わっています。' });
    const { pot } = await settleDuel(ctx.db, duel, round.winner);
    ctx.animate(ix, [{ after: 1000, payload: resultPayload(duel, entry, settings, em, round.winner, pot) }]);
    return update(revealFrame(duel, entry, em));
  }

  const drawn = state.round >= MAX_ROUNDS;
  const next = {
    ...state,
    energy: round.energy,
    choice: { challenger: null, opponent: null },
    round: state.round + 1,
    log,
  };

  if (drawn) {
    if (!(await finishDuel(ctx.db, duel, next))) return reply({ content: 'この勝負はもう終わっています。' });
    await refundDuel(ctx.db, duel);
    ctx.animate(ix, [{ after: 1000, payload: drawPayload(duel, settings, em) }]);
    return update(revealFrame(duel, entry, em));
  }

  const moved = await mutate(ctx.db, duel.id, () => ({ state: next }));
  if (!moved.ok) return reply({ content: 'この勝負はもう終わっています。' });

  ctx.animate(ix, [{ after: 1000, payload: board(moved.duel, next, settings, em, `**${round.reason}**`) }]);
  return update(revealFrame(duel, entry, em));
}

/** 出した手を見せる一瞬。 */
function revealFrame(duel, entry, em) {
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

export function board(duel, state, settings, em, headline = null) {
  const waiting = [];
  if (!state.choice.challenger) waiting.push(duel.challenger_id);
  if (!state.choice.opponent) waiting.push(duel.opponent_id);

  const history = state.log
    .slice(-4)
    .map((entry) => {
      const mark = entry.winner ? '💥' : '・';
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
          { name: '挑戦者', value: energyBar(duel.challenger_id, state.energy.challenger, state.choice.challenger), inline: true },
          { name: '相手', value: energyBar(duel.opponent_id, state.energy.opponent, state.choice.opponent), inline: true },
          { name: '勝てば', value: coins(duel.escrow * 2, settings), inline: true },
        ],
        footer: { text: `${MAX_ROUNDS}ラウンドで決着がつかなければ引き分け（返金）` },
      }),
    ],
    components: moveRows(duel),
    allowed_mentions: { users: waiting },
  };
}

function energyBar(userId, energy, chosen) {
  const bar = energy > 0 ? '⚡'.repeat(Math.min(energy, 6)) : '—';
  return `<@${userId}>\n${bar} (${energy})${chosen ? '\n✅ 手を選びました' : ''}`;
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
          style: move === 'big' ? ButtonStyle.DANGER : move === 'shoot' ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
        }),
      ),
    ),
  ];
}

function resultPayload(duel, entry, settings, em, winner, pot) {
  const winnerId = userIdOf(duel, winner);
  const loserId = userIdOf(duel, winner === 'challenger' ? 'opponent' : 'challenger');
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
          `🏆 **<@${winnerId}> の勝ち！** ${coins(pot, settings)} を総取りしました。`,
      }),
    ],
    components: [],
    allowed_mentions: { users: [winnerId, loserId] },
  };
}

function drawPayload(duel, settings, em) {
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
