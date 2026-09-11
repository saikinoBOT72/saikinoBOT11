/**
 * 決着したあとの「もう一度」。
 *
 * 1対1の勝負（じゃんけん・チンチロ・ロシアンルーレット・チャージ＆シュート・
 * 地雷＆陣取り）は、結果のメッセージに再戦ボタンを付けておく。
 * 押した人が新しい挑戦者になるので、負けた側からやり返せる。
 *
 * 押されたら元のメッセージからボタンを外す。そうしないと同じ結果から
 * 何度でも挑戦状が飛んでしまう。新しい結果メッセージには、また
 * 再戦ボタンが付くので、勝負を続けたいだけ続けられる。
 */
import { getBalance } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { button } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

/** 結果メッセージに付けるボタン。namespace は 'rps' などの公開ボタンの系統。 */
export function rematchButton(namespace, id, bet = 0) {
  return button(`${namespace}:again:${id}`, bet > 0 ? `再戦（${bet.toLocaleString('ja-JP')}）` : '再戦', {
    emoji: '🔁',
    style: ButtonStyle.SUCCESS,
  });
}

/**
 * 再戦ボタンが押されたとき。
 * @param {object} options
 * @param {string} options.challengerId 終わった勝負の挑戦者
 * @param {string} options.opponentId   終わった勝負の相手
 * @param {number} options.bet          同じ賭け金で挑む
 * @param {(args: {challengerId: string, opponentId: string, bet: number, settings: object}) => Promise<object|null>} options.start
 *        新しい挑戦状を投げる関数。投稿したメッセージか、失敗したら null を返すこと。
 */
export async function handleRematch(ix, ctx, { challengerId, opponentId, bet, start }) {
  if (ix.userId !== challengerId && ix.userId !== opponentId) {
    return reply({ content: 'この勝負の参加者ではありません。' });
  }

  // 押した人が挑む側。相手が「受けて立つ」を押せば始まる
  const opponent = ix.userId === challengerId ? opponentId : challengerId;
  const settings = await ctx.settings(ix.guildId);

  if (bet > 0) {
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    const check = checkBet(bet, balance, settings);
    if (!check.ok) return reply({ content: check.message });
  }

  const sent = await start({ challengerId: ix.userId, opponentId: opponent, bet, settings });
  if (!sent) return reply({ content: '挑戦状を送れませんでした。' });

  // 結果はそのまま残し、ボタンだけ外す（二重に挑戦状が飛ばないように）
  return update({ components: [] });
}
