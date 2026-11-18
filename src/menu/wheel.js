/**
 * 🎡 ルーレット（ひとりで）。張り方を選ぶ → 金額 → 回す。結果は回した瞬間に決まって精算する。
 */
import { getBalance, settleWager } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { BETS, NUMBER_MULTIPLIER, betLabel, colorOf, multiplierOf, spinWheel } from '../lib/wheel.js';
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

const COLOR = 0x16a085;

async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const kinds = Object.entries(BETS);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLOR,
          title: '🎡 ルーレット',
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            '0〜36のどこに止まるかに張ります（0は🟢緑で、赤・黒・偶数・奇数などには入りません）。\n\n' +
            'まず、どこに張るかを選んでください。',
          fields: [
            { name: '×2', value: '赤・黒・偶数・奇数・1〜18・19〜36', inline: true },
            { name: '×3', value: '1〜12・13〜24・25〜36', inline: true },
            { name: `×${NUMBER_MULTIPLIER}`, value: '数字1つ（0〜36）', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(...kinds.slice(0, 5).map(([key, bet]) => button(id('wheel', 'kind', key), bet.label, { emoji: bet.emoji, style: ButtonStyle.PRIMARY }))),
      row(
        ...kinds.slice(5).map(([key, bet]) => button(id('wheel', 'kind', key), bet.label, { emoji: bet.emoji, style: ButtonStyle.PRIMARY })),
        button(id('wheel', 'number'), '数字1つ', { emoji: '🎯', style: ButtonStyle.SUCCESS }),
      ),
      row(backButton('games'), homeButton()),
    ],
  });
}

/** 張り方が決まったら金額を選ぶ。 */
async function kind(ix, [key], ctx, notice = null) {
  if (!BETS[key]) return open(ix, [], ctx, 'その張り方はありません。');
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLOR,
          title: `🎡 ルーレット — ${BETS[key].emoji} ${BETS[key].label}（×${BETS[key].multiplier}）`,
          description: `所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。`,
        }),
        notice,
      ),
    ],
    components: amountRows(['wheel', 'go', key], balance, {
      maxBet: settings.max_bet,
      customId: id('wheel', 'custom', key),
      extra: [backButton('wheel', '張り方を変える')],
    }),
  });
}

function custom(ix, [key]) {
  return openModal(modal(id('wheel', 'amount', key), 'ルーレット', [textInput('amount', '賭け金', { placeholder: '例: 250', required: true, max: 12 })]));
}

async function amount(ix, [key], ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return kind(ix, [key], ctx, value.error);
  return go(ix, [key, String(value)], ctx);
}

/** 数字1つ：数字と金額を一緒に入れてもらう。 */
function number() {
  return openModal(
    modal(id('wheel', 'numgo'), 'ルーレット（数字1つ）', [
      textInput('pick', '張る数字（0〜36）', { placeholder: '例: 17', required: true, max: 2 }),
      textInput('amount', '賭け金', { placeholder: '例: 100', required: true, max: 12 }),
    ]),
  );
}

async function numgo(ix, _args, ctx) {
  const pick = readInt(ix, 'pick', { min: 0, max: 36 });
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(pick)) return open(ix, [], ctx, pick.error);
  if (isError(value)) return open(ix, [], ctx, value.error);
  if (pick === null || value === null) return open(ix, [], ctx, '数字と賭け金を入れてください。');
  return go(ix, ['num', String(value), String(pick)], ctx);
}

async function go(ix, [key, rawBet, rawPick], ctx) {
  const bet = Number(rawBet);
  const pick = key === 'num' ? Number(rawPick) : null;
  if (key !== 'num' && !BETS[key]) return open(ix, [], ctx, 'その張り方はありません。');
  if (key === 'num' && !(Number.isInteger(pick) && pick >= 0 && pick <= 36)) return open(ix, [], ctx, '数字は0〜36で選んでください。');

  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return key === 'num' ? open(ix, [], ctx, check.message) : kind(ix, [key], ctx, check.message);

  const landed = spinWheel();
  const multiplier = multiplierOf(key, landed, pick);
  const payout = bet * multiplier;
  const settled = await settleWager(ctx.db, ix.guildId, ix.userId, {
    bet,
    payout,
    betReason: 'roulette:bet',
    winReason: 'roulette:win',
    detail: `${betLabel(key, pick)} → ${landed}`,
  });
  if (!settled.ok) return open(ix, [], ctx, '残高が足りません。');
  const net = payout - bet;
  const color = colorOf(landed);
  const label = betLabel(key, pick);
  const againId = key === 'num' ? id('wheel', 'go', 'num', String(bet), String(pick)) : id('wheel', 'go', key, String(bet));

  ctx.animate(ix, [
    {
      after: 1400,
      payload: {
        ...resultEmbed({
          art: `${color.emoji}`,
          verdict: multiplier > 0 ? `🎉 ${landed}（${color.label}）— 当たり！ ×${multiplier}` : `💧 ${landed}（${color.label}）— はずれ`,
          color: multiplier > 0 ? 0x2ecc71 : 0x95a5a6,
          detail: `**${label}** に張っていました。`,
          fields: moneyFields(bet, net, settled.balance, settings, { coins }),
        }),
        components: [
          row(
            button(againId, `もう一度（${label} ${bet}）`, { emoji: '🔁', style: ButtonStyle.SUCCESS, disabled: settled.balance < bet }),
            button(id('wheel', 'open'), '張り方を変える', { emoji: '🎡' }),
            shareButton(),
            homeButton(),
          ),
        ],
      },
    },
  ]);

  goLive(ctx, ix, settings, {
    net,
    force: key === 'num' && multiplier > 0,
    embed: embed({
      color: net > 0 ? 0xf1c40f : 0x95a5a6,
      title: key === 'num' && multiplier > 0 ? '🎯 ルーレットで数字を的中！' : net > 0 ? '🎡 ルーレットで大勝ち' : '🎡 ルーレットで大負け',
      description: `<@${ix.userId}> が ${label} に張って ${landed}（${color.label}）で **${net > 0 ? '+' : ''}${net.toLocaleString('ja-JP')}**`,
    }),
  });

  return show(ix, {
    content: '🎡',
    embeds: [embed({ color: COLOR, title: '🎡 回転中…', footer: { text: `${label} に ${bet.toLocaleString('ja-JP')}` } })],
    components: [],
  });
}

export const actions = { open, kind, custom, amount, number, numgo, go };
