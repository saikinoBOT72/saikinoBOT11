/**
 * 募集中の卓の「🚶 抜ける」「🗑️ 解散」（ブラックジャック・ポーカー・ピッグ・ヨットで共通）。
 *
 * 【抜ける】座った人が、始まる前なら抜けられる。払った参加費は返す。
 *   卓を立てた人は抜けられない（親がいなくなると始められないので「解散」を使う）。
 * 【解散】卓を立てた人だけが、始まる前なら解散できる。全員に参加費を返す。
 *
 * 【返すお金の決め方】
 * 「その卓に払った額から、返した額を引いた残り」を履歴から数え、残っているぶんだけ返す。
 * 座る処理（席を取る→参加費を払う）の途中で「抜ける」が割り込んでも、
 * 払う前なら返さず、払ったあとなら返す。二重に返すこともない。
 */
import { button, embed } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { refundSeat } from '../lib/card-table.js';

/** 募集中の掲示に足すボタン。 */
export function lobbyButtons(prefix, tableId) {
  return [
    button(`${prefix}:leave:${tableId}`, '抜ける', { emoji: '🚶' }),
    button(`${prefix}:disband:${tableId}`, '解散（親）', { emoji: '🗑️', style: ButtonStyle.DANGER }),
  ];
}

/**
 * @param {object} kit 卓ごとの道具
 * @param {Function} kit.mutate 卓の store の mutate
 * @param {(table: object, state: object) => object} kit.lobby 募集中の掲示を作る
 * @param {string} kit.refundReason 返金の理由（'poker:refund' など）
 */
export async function handleLeave(ix, ctx, table, kit) {
  if (table.status !== 'joining') return reply({ content: 'もう始まっているので、抜けられません。' });
  if (ix.userId === table.host_id) {
    return reply({ content: '卓を立てた人は抜けられません。やめるときは「🗑️ 解散」を押してください。' });
  }

  const left = await kit.mutate(
    ctx.db,
    table.id,
    ({ state }) => {
      if (!state.players.some((player) => player.userId === ix.userId)) return { reject: 'absent' };
      return { state: { ...state, players: state.players.filter((player) => player.userId !== ix.userId) } };
    },
    { allow: ['joining'] },
  );
  if (!left.ok) {
    const messages = {
      absent: 'この卓には座っていません。',
      closed: 'もう始まっているので、抜けられません。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[left.reason] ?? '抜けられませんでした。' });
  }

  await refundSeat(ctx.db, table.guild_id, ix.userId, table.id, kit.refundReason);
  return update(kit.lobby(left.table, left.state));
}

/**
 * @param {object} kit
 * @param {Function} kit.close 卓の store の close
 * @param {Function} kit.stateOf
 * @param {string} kit.refundReason
 */
export async function handleDisband(ix, ctx, table, kit) {
  if (table.status !== 'joining') return reply({ content: 'もう始まっているので、解散できません。' });
  if (ix.userId !== table.host_id) return reply({ content: '解散できるのは卓を立てた人だけです。' });

  const state = kit.stateOf(table);
  if (!(await kit.close(ctx.db, table, { status: 'cancelled' }))) {
    return reply({ content: '混み合っています。もう一度押してください。' });
  }
  for (const player of state.players) {
    await refundSeat(ctx.db, table.guild_id, player.userId, table.id, kit.refundReason);
  }

  return update({
    content: '',
    embeds: [
      embed({
        color: 0x95a5a6,
        title: '🗑️ 卓を解散しました',
        description: `<@${table.host_id}> が始める前に解散しました。${table.bet > 0 ? '払った参加費は全員に返しました。' : ''}`,
      }),
    ],
    components: [],
  });
}
