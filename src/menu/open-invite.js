/**
 * 挑戦状の「受けて立つ」「やめておく」を押した人の確認（じゃんけん・チンチロ・1対1の勝負で共通）。
 *
 * 相手が決まっている挑戦状：呼ばれた本人だけが押せる。
 * だれでも受けられる挑戦状：出した人以外の、最初に押した1人が相手になる。
 *   参加に要る額が払えない人は、取らずに断る（取ってから中止になると、ほかの人も受けられなくなるため）。
 *   「やめておく」は、出した人が押したときだけ取り下げになる。
 */
import { reply, update } from '../discord/respond.js';
import { getBalance } from '../lib/economy.js';
import { claimOpenChallenge, isOpenChallenge, withdrawOpenChallenge } from '../lib/open-challenge.js';

/**
 * @param {object} options
 * @param {string} options.table D1 のテーブル名
 * @param {object} options.match 挑戦状の行
 * @param {'accept'|'decline'} options.action
 * @param {number} options.need 受けるのに要る額（預かる額）
 * @param {(text: string) => object} options.cancelled 流れたときの embed
 * @returns {Promise<{match: object} | {response: Response}>}
 */
export async function resolveInvite(ix, ctx, { table, match, action, need, cancelled }) {
  if (!isOpenChallenge(match.opponent_id)) {
    if (ix.userId !== match.opponent_id) return { response: reply({ content: 'この勝負に呼ばれているのはあなたではありません。' }) };
    return { match };
  }

  if (action === 'decline') {
    if (ix.userId !== match.challenger_id) {
      return { response: reply({ content: 'だれでも受けられる挑戦状です。受けないときは、そのままにしておけば大丈夫です。' }) };
    }
    if (!(await withdrawOpenChallenge(ctx.db, table, match.id, ix.userId))) {
      return { response: reply({ content: 'もう誰かが受けたか、終わっています。' }) };
    }
    return {
      response: update({ content: '', embeds: [cancelled(`<@${match.challenger_id}> が挑戦状を取り下げました。`)], components: [] }),
    };
  }

  if (ix.userId === match.challenger_id) return { response: reply({ content: '自分で出した挑戦状は受けられません。' }) };
  if (need > 0 && (await getBalance(ctx.db, match.guild_id, ix.userId)) < need) {
    return { response: reply({ content: `受けるには ${need.toLocaleString('ja-JP')} 必要です（残高が足りません）。` }) };
  }
  if (!(await claimOpenChallenge(ctx.db, table, match.id, ix.userId))) {
    return { response: reply({ content: 'ひと足早く、ほかの人が受けました。' }) };
  }
  return { match: { ...match, opponent_id: ix.userId } };
}

/** 挑戦状の投稿の、相手に関わる部分。 */
export function inviteParts(challengerId, opponentId) {
  const open = isOpenChallenge(opponentId);
  return {
    content: open ? '' : `<@${opponentId}>`,
    line: open
      ? `<@${challengerId}> が勝負の相手を募集しています。**だれでも受けられます**（先着1人）。`
      : `<@${challengerId}> が <@${opponentId}> に勝負を挑みました。`,
    declineLabel: open ? '取り下げる（出した人）' : 'やめておく',
    allowed_mentions: open ? { parse: [] } : { users: [opponentId] },
  };
}
