import { deposit, getBalance, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import {
  MAX_MULTIPLIER,
  MAX_STEPS,
  canChoose,
  cardLabel,
  drawCard,
  judge,
  multiply,
  payout,
  stepMultiplier,
} from '../lib/highlow.js';
import { createSoloStore } from '../lib/solo-session.js';
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
  openModal,
  readInt,
  row,
  shareButton,
  show,
  withNotice,
} from './common.js';


/* ------------------------------------------------------------------ 進行中の勝負 */

// 進める・降りる・外れる、のどれも「読んだときの版のまま」でなければ通らない
// （2台の端末で同時に押しても、払い戻しが2回入ったりしない）
const store = createSoloStore('highlow_games', ['bet', 'card_rank', 'card_suit', 'multiplier', 'steps']);

const getGame = (ctx, ix) => store.get(ctx.db, ix.guildId, ix.userId);

/** 勝負の中身を、保存する列の形にする。 */
const toRow = (game) => ({
  bet: game.bet,
  card_rank: game.card.rank,
  card_suit: game.card.suit,
  multiplier: game.multiplier,
  steps: game.steps,
});

/** 別の端末からの操作が先に入っていたとき。いまの状態を出し直す。 */
async function stale(ix, ctx) {
  const fresh = await getGame(ctx, ix);
  if (!fresh) return open(ix, [], ctx, 'この勝負はもう終わっています。');
  return table(ix, ctx, fresh, '別の操作が先に入りました。いまの状態です。');
}

/* ------------------------------------------------------------------ 画面 */

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const running = await getGame(ctx, ix);
  if (running) return table(ix, ctx, running, '前回の続きです。');

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x2980b9,
          title: '🃏 ハイ&ロー',
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            'カードが1枚めくれます。**次のカードが上か下か**を当ててください。\n' +
            '当たるたび倍率が伸び、**いつでも降りて確定**できます。外したら賭け金は全部失います。\n' +
            '同じ数字が出たら引き分けで、もう1枚めくります。',
          fields: [
            { name: '倍率', value: '当たりにくい予想ほど高い（例: 2でLOWは約×11）', inline: true },
            { name: '上限', value: `${MAX_STEPS}連勝、または累積×${MAX_MULTIPLIER}まで`, inline: true },
          ],
          footer: { text: '1回で降りれば還元率は約97%。粘るほど下がります' },
        }),
        notice,
      ),
    ],
    components: amountRows(['hl', 'bet'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
  });
}

export function custom() {
  return openModal(
    modal(id('hl', 'amount'), 'ハイ&ロー', [
      textInput('amount', '賭け金', { placeholder: '例: 250', required: true, max: 12 }),
    ]),
  );
}

export async function amount(ix, _args, ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return open(ix, [], ctx, value.error);
  return start(ix, ctx, value);
}

export async function bet(ix, [rawBet], ctx) {
  return start(ix, ctx, Number(rawBet));
}

async function start(ix, ctx, betAmount) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(betAmount, balance, settings);
  if (!check.ok) return open(ix, [], ctx, check.message);

  if (await getGame(ctx, ix)) return open(ix, [], ctx, 'すでに勝負が進んでいます。');
  if (!(await withdraw(ctx.db, ix.guildId, ix.userId, betAmount, 'highlow:bet'))) {
    return open(ix, [], ctx, '残高が足りません。');
  }

  const game = toRow({ bet: betAmount, card: drawCard(), multiplier: 1, steps: 0 });
  if (!(await store.start(ctx.db, ix.guildId, ix.userId, game))) {
    // 同じ瞬間にもう1つ始まっていた。預かったぶんは返す
    await deposit(ctx.db, ix.guildId, ix.userId, betAmount, 'highlow:refund');
    return open(ix, [], ctx, 'すでに勝負が進んでいます。');
  }
  return table(ix, ctx, game);
}

/** 場の状態。次の予想を選ぶ画面。 */
async function table(ix, ctx, game, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji();
  const card = { rank: game.card_rank, suit: game.card_suit };
  const highMultiplier = stepMultiplier(card.rank, 'high');
  const lowMultiplier = stepMultiplier(card.rank, 'low');
  const current = payout(game.bet, game.multiplier);

  return show(ix, {
    content: cardLabel(card, em),
    embeds: [
      withNotice(
        embed({
          color: 0x2980b9,
          title: '次のカードは 上か 下か？',
          fields: [
            {
              name: '⬆️ HIGH',
              value: canChoose(card.rank, 'high') ? `×${highMultiplier}` : '選べません',
              inline: true,
            },
            {
              name: '⬇️ LOW',
              value: canChoose(card.rank, 'low') ? `×${lowMultiplier}` : '選べません',
              inline: true,
            },
            { name: '賭け金', value: `${game.bet.toLocaleString('ja-JP')}`, inline: true },
            { name: 'いまの倍率', value: `×${game.multiplier}（${game.steps}連勝）`, inline: true },
            { name: '降りたら', value: coins(current, settings), inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('hl', 'pick', 'high'), 'HIGH', {
          emoji: '⬆️',
          style: ButtonStyle.PRIMARY,
          disabled: !canChoose(card.rank, 'high'),
        }),
        button(id('hl', 'pick', 'low'), 'LOW', {
          emoji: '⬇️',
          style: ButtonStyle.PRIMARY,
          disabled: !canChoose(card.rank, 'low'),
        }),
        button(id('hl', 'stop'), `降りる（${current}）`, { emoji: '🏳️', style: ButtonStyle.SUCCESS, disabled: game.steps === 0 }),
      ),
    ],
  });
}

export async function pick(ix, [choice], ctx) {
  const game = await getGame(ctx, ix);
  if (!game) return open(ix, [], ctx, '進行中の勝負がありません。');

  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji();
  const card = { rank: game.card_rank, suit: game.card_suit };
  if (!canChoose(card.rank, choice)) return table(ix, ctx, game, 'その予想は選べません。');

  const step = stepMultiplier(card.rank, choice);
  const next = drawCard();
  const result = judge(card, next, choice);

  // カードは content に絵文字だけ。ここがいちばん大きく出る
  const flipping = {
    content: `${cardLabel(card, em)}${em.card_back}`,
    embeds: [
      embed({
        color: 0x2980b9,
        title: `${choice === 'high' ? '⬆️ HIGH' : '⬇️ LOW'} に賭けた — めくっています…`,
      }),
    ],
  };

  if (result === 'draw') {
    const moved = await store.advance(
      ctx.db,
      game,
      toRow({ bet: game.bet, card: next, multiplier: game.multiplier, steps: game.steps }),
    );
    if (!moved) return stale(ix, ctx);
    ctx.animate(ix, [{ after: 900, payload: await drawFrame(ix, ctx, card, next, game, '同じ数字！ 引き分けでもう1枚。') }]);
    return show(ix, { ...flipping, components: [] });
  }

  if (result === 'lose') {
    if (!(await store.lose(ctx.db, game))) return stale(ix, ctx);
    goLive(ctx, ix, settings, {
      net: -game.bet,
      embed: embed({
        color: 0x95a5a6,
        title: '🃏 ハイ&ローで大負け',
        description: `<@${ix.userId}> が ${game.steps}連勝のあとで外して **-${game.bet.toLocaleString('ja-JP')}**`,
      }),
    });
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 900,
        payload: {
          content: `${cardLabel(card, em)}${cardLabel(next, em)}`,
          embeds: [
            embed({
              color: 0x95a5a6,
              title: '💧 はずれ',
              description: `${coins(game.bet, settings)} を失いました。`,
              fields: [
                { name: 'そこまでの倍率', value: `×${game.multiplier}（${game.steps}連勝）`, inline: true },
                { name: '所持金', value: coins(balance, settings), inline: true },
              ],
            }),
          ],
          components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), shareButton(), homeButton())],
        },
      },
    ]);
    return show(ix, { ...flipping, components: [] });
  }

  // 当たり
  const total = multiply(game.multiplier, step);
  const steps = game.steps + 1;
  const forced = steps >= MAX_STEPS || total >= MAX_MULTIPLIER;

  if (forced) {
    const won = payout(game.bet, total);
    if (!(await store.cashOut(ctx.db, game, won, 'highlow:win', `×${total}`))) return stale(ix, ctx);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 900,
        payload: {
          content: `${cardLabel(card, em)}${cardLabel(next, em)}`,
          embeds: [
            embed({
              color: 0xf1c40f,
              title: `🎉 ${steps}連勝・×${total} で上限到達！`,
              description: `ここまでで自動的に確定しました。${coins(won, settings)} を獲得！`,
              fields: [{ name: '所持金', value: coins(balance, settings), inline: true }],
            }),
          ],
          components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), shareButton(), homeButton())],
        },
      },
    ]);
    goLive(ctx, ix, settings, {
      net: won - game.bet,
      force: true,
      embed: embed({
        color: 0xf1c40f,
        title: '🃏 ハイ&ローで上限到達！',
        description: `<@${ix.userId}> が **${steps}連勝（×${total}）**！ ${coins(won, settings)} を獲得しました。`,
      }),
    });
    return show(ix, { ...flipping, components: [] });
  }

  if (!(await store.advance(ctx.db, game, toRow({ bet: game.bet, card: next, multiplier: total, steps })))) {
    return stale(ix, ctx);
  }
  ctx.animate(ix, [
    { after: 900, payload: await drawFrame(ix, ctx, card, next, { ...game, multiplier: total, steps }, '当たり！') },
  ]);
  return show(ix, { ...flipping, components: [] });
}

/** めくったあとの場（次の予想を選べる状態）を、演出の最終コマとして作る。 */
async function drawFrame(ix, ctx, previous, next, game, headline) {
  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji();
  const current = payout(game.bet, game.multiplier);

  return {
    content: `${cardLabel(previous, em)}${cardLabel(next, em)}`,
    embeds: [
      embed({
        color: 0x2ecc71,
        title: headline,
        description: '次はどっち？',
        fields: [
          {
            name: '⬆️ HIGH',
            value: canChoose(next.rank, 'high') ? `×${stepMultiplier(next.rank, 'high')}` : '選べません',
            inline: true,
          },
          {
            name: '⬇️ LOW',
            value: canChoose(next.rank, 'low') ? `×${stepMultiplier(next.rank, 'low')}` : '選べません',
            inline: true,
          },
          { name: 'いまの倍率', value: `×${game.multiplier}（${game.steps}連勝）`, inline: true },
          { name: '降りたら', value: coins(current, settings), inline: true },
        ],
      }),
    ],
    components: [
      row(
        button(id('hl', 'pick', 'high'), 'HIGH', {
          emoji: '⬆️',
          style: ButtonStyle.PRIMARY,
          disabled: !canChoose(next.rank, 'high'),
        }),
        button(id('hl', 'pick', 'low'), 'LOW', {
          emoji: '⬇️',
          style: ButtonStyle.PRIMARY,
          disabled: !canChoose(next.rank, 'low'),
        }),
        button(id('hl', 'stop'), `降りる（${current}）`, {
          emoji: '🏳️',
          style: ButtonStyle.SUCCESS,
          disabled: game.steps === 0,
        }),
      ),
    ],
  };
}

export async function stop(ix, _args, ctx) {
  const game = await getGame(ctx, ix);
  if (!game) return open(ix, [], ctx, '進行中の勝負がありません。');
  if (game.steps === 0) return table(ix, ctx, game, '1回も当ててからでないと降りられません。');

  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji();
  const won = payout(game.bet, game.multiplier);
  // 払い戻しと片付けは1つの処理。別の端末で先に降りていたら、ここでは何も払わない
  if (!(await store.cashOut(ctx.db, game, won, 'highlow:win', `×${game.multiplier}`))) return stale(ix, ctx);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  goLive(ctx, ix, settings, {
    net: won - game.bet,
    embed: embed({
      color: 0xf1c40f,
      title: '🃏 ハイ&ローで大勝ち',
      description: `<@${ix.userId}> が **${game.steps}連勝（×${game.multiplier}）** で降りて **+${(won - game.bet).toLocaleString('ja-JP')}**`,
    }),
  });

  return show(ix, {
    content: cardLabel({ rank: game.card_rank, suit: game.card_suit }, em),
    embeds: [
      embed({
        color: 0x2ecc71,
        title: `🏆 ${game.steps}連勝・×${game.multiplier} で確定！`,
        description: `${coins(won, settings)} を獲得しました。`,
        fields: [
          { name: '賭け金', value: `${game.bet.toLocaleString('ja-JP')}`, inline: true },
          { name: '所持金', value: coins(balance, settings), inline: true },
        ],
      }),
    ],
    components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), shareButton(), homeButton())],
  });
}

export const actions = { open, bet, custom, amount, pick, stop };
