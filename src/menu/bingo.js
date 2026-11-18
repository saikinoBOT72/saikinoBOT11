/**
 * 🎱 ビンゴ（ひとりで）。賭けた瞬間に結果が決まって精算し、球を引く様子は演出として見せる。
 */
import { getBalance, settleWager } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { BALLS, PAYOUT_TABLE, playBingo, renderCard, scoreCard } from '../lib/bingo.js';
import { goLive } from '../lib/guild-prefs.js';
import { modal, textInput } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import {
  amountRows,
  backButton,
  button,
  embed,
  homeButton,
  id,
  isError,
  moneyFields,
  openModal,
  readInt,
  resultEmbed,
  row,
  shareButton,
  show,
  withNotice,
} from './common.js';

const COLOR = 0x3498db;

async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLOR,
          title: '🎱 ビンゴ',
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            `5×5のカード（真ん中は最初から空き）に、75個の球から **${BALLS}個** を引きます。\n` +
            '縦・横・斜めにそろった本数で払い戻します。\n\n' +
            '賭け金を選んでください。',
          fields: [{ name: '払い戻し', value: PAYOUT_TABLE.map(([lines, rate]) => `${lines} **${rate}**`).join('\n'), inline: true }],
        }),
        notice,
      ),
    ],
    components: amountRows(['bingo', 'go'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
  });
}

function custom() {
  return openModal(modal(id('bingo', 'amount'), 'ビンゴ', [textInput('amount', '賭け金', { placeholder: '例: 250', required: true, max: 12 })]));
}

async function amount(ix, _args, ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return open(ix, [], ctx, value.error);
  return go(ix, [String(value)], ctx);
}

async function go(ix, [rawBet], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return open(ix, [], ctx, check.message);

  const game = playBingo();
  const payout = Math.floor(bet * game.multiplier);
  const settled = await settleWager(ctx.db, ix.guildId, ix.userId, {
    bet,
    payout,
    betReason: 'bingo:bet',
    winReason: 'bingo:win',
    detail: `${game.lines}ライン`,
  });
  if (!settled.ok) return open(ix, [], ctx, '残高が足りません。');
  const net = payout - bet;

  // 球を3回に分けて引いていく（結果はもう決まっている）
  const frame = (count, title) => {
    const shown = game.balls.slice(0, count);
    return {
      content: '',
      embeds: [
        embed({
          color: COLOR,
          title,
          description: `\`\`\`\n${renderCard(game.card, shown)}\n\`\`\`\n引いた球 ${count}/${BALLS}　最後: **${shown.at(-1) ?? '—'}**`,
        }),
      ],
      components: [],
    };
  };
  const midway = scoreCard(game.card, game.balls.slice(0, 24));
  const verdict =
    game.lines === 0
      ? `💧 そろわず（リーチ ${game.reaches} 本）`
      : `🎉 ${game.lines}ライン！ ×${game.multiplier}`;

  ctx.animate(ix, [
    { after: 900, payload: frame(24, midway.reaches > 0 || midway.lines > 0 ? '🔥 リーチがかかった！' : '🎱 抽選中…') },
    {
      after: 1100,
      payload: {
        ...resultEmbed({
          verdict,
          color: payout > 0 ? 0x2ecc71 : 0x95a5a6,
          detail: `\`\`\`\n${renderCard(game.card, game.balls, { marked: game.marked })}\n\`\`\`\n[ ] は出た数字、< > はそろった列です。`,
          fields: moneyFields(bet, net, settled.balance, settings, { coins }),
        }),
        components: [
          row(
            button(id('bingo', 'go', String(bet)), `もう一度（${bet}）`, {
              emoji: '🔁',
              style: ButtonStyle.SUCCESS,
              disabled: settled.balance < bet,
            }),
            button(id('bingo', 'open'), '賭け金を変える', { emoji: '💰' }),
            shareButton(),
            homeButton(),
          ),
        ],
      },
    },
  ]);

  goLive(ctx, ix, settings, {
    net,
    force: game.lines >= 3,
    embed: embed({
      color: net > 0 ? 0xf1c40f : 0x95a5a6,
      title: game.lines >= 3 ? '🎉 ビンゴで大当たり！' : net > 0 ? '🎱 ビンゴで大勝ち' : '🎱 ビンゴで大負け',
      description: `<@${ix.userId}> がビンゴで **${game.lines}ライン**（${net > 0 ? '+' : ''}${net.toLocaleString('ja-JP')}）`,
    }),
  });

  return show(ix, frame(12, '🎱 抽選中…'));
}

export const actions = { open, custom, amount, go };
