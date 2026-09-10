/**
 * ロシアンルーレット（1対1）。
 *
 * 弾倉6つに実弾1発。回転させずに順番に引くので 1/6 → 1/5 → 1/4 … と上がっていく。
 * 引き金を引いた人に当たったら、その人の負け。相手が賭け金を総取りする。
 */
import { CHAMBERS, chanceAt, chambersLeft, cylinder, loadBullet } from '../lib/roulette.js';
import { advance, finishDuel, otherRole, randomFirst, settleDuel, userIdOf } from '../lib/duel.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { EMOJI as em } from '../lib/emoji.js';

export const key = 'rr';
export const title = 'ロシアンルーレット';
export const emojiSlot = 'roulette';
export const color = 0x992d22;
export const firstTurn = randomFirst;

export function inviteFields() {
  return [{ name: 'ルール', value: RULES }];
}

const RULES = [
  `弾倉は **${CHAMBERS}つ**、実弾は **1発**。回転させずに順番に引きます。`,
  '1回目は **1/6**、外れたら次は **1/5**、その次は **1/4** …と上がっていきます。',
  '引き金を引いて当たった人の**負け**。相手が賭け金を総取りします。',
  '**先攻はランダム**に決まります。',
].join('\n');

/** 勝負が始まるとき。実弾の位置をここで決める（state はプレイヤーには見えない）。 */
export async function start(ctx, { duel, settings }) {
  const state = { bulletAt: loadBullet(), pulled: 0, log: [] };
  const started = await advance(ctx.db, duel, { state, turn: duel.turn });
  if (!started) return { content: '', embeds: [embed({ description: '開始できませんでした。' })], components: [] };
  return board(started, state, settings, `先攻は <@${userIdOf(duel, duel.turn)}> に決まりました。`);
}

export async function handle(ix, ctx, { duel, role, state, action }) {
  if (action !== 'pull') return reply({ content: '不明な操作です。' });
  if (duel.turn !== role) return reply({ content: 'いまはあなたの番ではありません。' });

  const settings = await ctx.settings(duel.guild_id);

  const pull = state.pulled + 1;
  const hit = pull === state.bulletAt;
  const next = {
    ...state,
    pulled: pull,
    log: [...state.log, { role, pull, hit }],
  };

  if (hit) {
    // 引いた人の負け
    if (!(await finishDuel(ctx.db, duel, next))) return reply({ content: 'この勝負はもう終わっています。' });
    const winner = otherRole(role);
    const { pot } = await settleDuel(ctx.db, duel, winner);
    ctx.animate(ix, [
      { after: 900, payload: pullFrame(duel, state, ix.userId, '…') },
      { after: 1100, payload: resultPayload(duel, next, settings, winner, pot) },
    ]);
    return update(pullFrame(duel, state, ix.userId, ''));
  }

  const moved = await advance(ctx.db, duel, { state: next, turn: otherRole(role) });
  if (!moved) return reply({ content: 'いまはあなたの番ではありません。' });

  ctx.animate(ix, [
    { after: 900, payload: pullFrame(duel, state, ix.userId, '…') },
    { after: 1000, payload: board(moved, next, settings, `カチッ…　<@${ix.userId}> は無事でした。`) },
  ]);
  return update(pullFrame(duel, state, ix.userId, ''));
}

/** 引き金を引いている最中の演出。 */
function pullFrame(duel, state, userId, tail) {
  return {
    content: '',
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description:
          `${cylinder(state.pulled)}\n\n` +
          `<@${userId}> がこめかみに当てました${tail}\n` +
          `**${Math.round(chanceAt(state.pulled + 1) * 100)}%** の確率で実弾`,
      }),
    ],
    components: [],
  };
}

/** 場の状態。次に引く人のボタンを出す。 */
export function board(duel, state, settings, headline = null) {
  const waiting = userIdOf(duel, duel.turn);
  const left = chambersLeft(state.pulled);
  const lines = [
    `${cylinder(state.pulled)}`,
    '',
    headline ? `${headline}\n` : '',
    `<@${waiting}> の番です。引き金を引いてください。`,
  ];

  return {
    content: `<@${waiting}>`,
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description: lines.filter((line) => line !== '').join('\n'),
        fields: [
          { name: '残り弾倉', value: `${left} / ${CHAMBERS}`, inline: true },
          { name: '当たる確率', value: `**${Math.round(chanceAt(state.pulled + 1) * 100)}%**`, inline: true },
          { name: '勝てば', value: coins(duel.escrow * 2, settings), inline: true },
        ],
        footer: { text: `${duel.pulled ?? state.pulled} 回引きました・外すほど危なくなります` },
      }),
    ],
    components: [row(button(`d:pull:${duel.id}`, '引き金を引く', { emoji: em.roulette, style: ButtonStyle.DANGER }))],
    allowed_mentions: { users: [waiting] },
  };
}

function resultPayload(duel, state, settings, winner, pot) {
  const loserId = userIdOf(duel, otherRole(winner));
  const winnerId = userIdOf(duel, winner);
  return {
    // 弾倉を content に絵文字だけで置く。ここがいちばん大きく出る
    content: cylinder(state.pulled),
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `🏆 <@${winnerId}> の勝ち！`,
        description:
          `**${state.pulled}発目で実弾**。<@${loserId}> に当たりました。\n` +
          `${coins(pot, settings)} を総取りしました。`,
      }),
    ],
    components: [],
    allowed_mentions: { users: [winnerId, loserId] },
  };
}
