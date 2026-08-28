import { deposit, getBalance, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import {
  MAX_MULTIPLIER,
  MAX_STEPS,
  canChoose,
  cardLabel,
  chances,
  drawCard,
  judge,
  multiply,
  payout,
  stepMultiplier,
} from '../lib/highlow.js';
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
  show,
  withNotice,
} from './common.js';

/* ------------------------------------------------------------------ 進行中の勝負 */

async function getGame(ctx, ix) {
  return ctx.db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', ix.guildId, ix.userId);
}

async function saveGame(ctx, ix, game) {
  await ctx.db.run(
    `INSERT INTO highlow_games (guild_id, user_id, bet, card_rank, card_suit, multiplier, steps, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       bet = excluded.bet, card_rank = excluded.card_rank, card_suit = excluded.card_suit,
       multiplier = excluded.multiplier, steps = excluded.steps`,
    ix.guildId,
    ix.userId,
    game.bet,
    game.card.rank,
    game.card.suit,
    game.multiplier,
    game.steps,
    Date.now(),
  );
}

async function clearGame(ctx, ix) {
  await ctx.db.run('DELETE FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', ix.guildId, ix.userId);
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

  const game = { bet: betAmount, card: drawCard(), multiplier: 1, steps: 0 };
  await saveGame(ctx, ix, game);
  return table(ix, ctx, toRow(game));
}

function toRow(game) {
  return {
    bet: game.bet,
    card_rank: game.card.rank,
    card_suit: game.card.suit,
    multiplier: game.multiplier,
    steps: game.steps,
  };
}

/** 場の状態。次の予想を選ぶ画面。 */
async function table(ix, ctx, game, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const card = { rank: game.card_rank, suit: game.card_suit };
  const chance = chances(card.rank);
  const highMultiplier = stepMultiplier(card.rank, 'high');
  const lowMultiplier = stepMultiplier(card.rank, 'low');
  const current = payout(game.bet, game.multiplier);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x2980b9,
          title: '🃏 ハイ&ロー',
          description:
            `# ${cardLabel(card)}\n次のカードは **上（HIGH）** か **下（LOW）** か？`,
          fields: [
            {
              name: '⬆️ HIGH',
              value: canChoose(card.rank, 'high')
                ? `×${highMultiplier}（当たる確率 ${Math.round(chance.high * 100)}%）`
                : '選べません',
              inline: true,
            },
            {
              name: '⬇️ LOW',
              value: canChoose(card.rank, 'low')
                ? `×${lowMultiplier}（当たる確率 ${Math.round(chance.low * 100)}%）`
                : '選べません',
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
  const card = { rank: game.card_rank, suit: game.card_suit };
  if (!canChoose(card.rank, choice)) return table(ix, ctx, game, 'その予想は選べません。');

  const step = stepMultiplier(card.rank, choice);
  const next = drawCard();
  const result = judge(card, next, choice);

  const flipping = embed({
    color: 0x2980b9,
    title: '🃏 ハイ&ロー',
    description: `# ${cardLabel(card)} → 🂠\n**${choice === 'high' ? '⬆️ HIGH' : '⬇️ LOW'}** に賭けました。めくっています…`,
  });

  if (result === 'draw') {
    await saveGame(ctx, ix, { bet: game.bet, card: next, multiplier: game.multiplier, steps: game.steps });
    ctx.animate(ix, [{ after: 900, payload: await drawFrame(ix, ctx, card, next, game, '同じ数字！ 引き分けでもう1枚。') }]);
    return show(ix, { embeds: [flipping], components: [] });
  }

  if (result === 'lose') {
    await clearGame(ctx, ix);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 900,
        payload: {
          embeds: [
            embed({
              color: 0x95a5a6,
              title: '🃏 ハイ&ロー',
              description:
                `# ${cardLabel(card)} → ${cardLabel(next)}\n` +
                `外れ… ${coins(game.bet, settings)} を失いました。`,
              fields: [
                { name: 'そこまでの倍率', value: `×${game.multiplier}（${game.steps}連勝）`, inline: true },
                { name: '所持金', value: coins(balance, settings), inline: true },
              ],
            }),
          ],
          components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
        },
      },
    ]);
    return show(ix, { embeds: [flipping], components: [] });
  }

  // 当たり
  const total = multiply(game.multiplier, step);
  const steps = game.steps + 1;
  const forced = steps >= MAX_STEPS || total >= MAX_MULTIPLIER;

  if (forced) {
    await clearGame(ctx, ix);
    const won = payout(game.bet, total);
    await deposit(ctx.db, ix.guildId, ix.userId, won, 'highlow:win', `×${total}`);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 900,
        payload: {
          embeds: [
            embed({
              color: 0xf1c40f,
              title: '🃏 ハイ&ロー — 上限到達！',
              description:
                `# ${cardLabel(card)} → ${cardLabel(next)}\n` +
                `🎉 **${steps}連勝・×${total}**！ ここまでで自動的に確定しました。\n${coins(won, settings)} を獲得！`,
              fields: [{ name: '所持金', value: coins(balance, settings), inline: true }],
            }),
          ],
          components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
        },
      },
    ]);
    ctx.announce(ix.channelId, {
      embeds: [
        embed({
          color: 0xf1c40f,
          title: '🃏 ハイ&ローで上限到達！',
          description: `<@${ix.userId}> が **${steps}連勝（×${total}）**！ ${coins(won, settings)} を獲得しました。`,
        }),
      ],
    });
    return show(ix, { embeds: [flipping], components: [] });
  }

  await saveGame(ctx, ix, { bet: game.bet, card: next, multiplier: total, steps });
  ctx.animate(ix, [
    { after: 900, payload: await drawFrame(ix, ctx, card, next, { ...game, multiplier: total, steps }, '当たり！') },
  ]);
  return show(ix, { embeds: [flipping], components: [] });
}

/** めくったあとの場（次の予想を選べる状態）を、演出の最終コマとして作る。 */
async function drawFrame(ix, ctx, previous, next, game, headline) {
  const settings = await ctx.settings(ix.guildId);
  const chance = chances(next.rank);
  const current = payout(game.bet, game.multiplier);

  return {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '🃏 ハイ&ロー',
        description: `# ${cardLabel(previous)} → ${cardLabel(next)}\n${headline} 次はどっち？`,
        fields: [
          {
            name: '⬆️ HIGH',
            value: canChoose(next.rank, 'high')
              ? `×${stepMultiplier(next.rank, 'high')}（${Math.round(chance.high * 100)}%）`
              : '選べません',
            inline: true,
          },
          {
            name: '⬇️ LOW',
            value: canChoose(next.rank, 'low')
              ? `×${stepMultiplier(next.rank, 'low')}（${Math.round(chance.low * 100)}%）`
              : '選べません',
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
  const won = payout(game.bet, game.multiplier);
  await clearGame(ctx, ix);
  await deposit(ctx.db, ix.guildId, ix.userId, won, 'highlow:win', `×${game.multiplier}`);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '🃏 ハイ&ロー — 確定！',
        description: `${game.steps}連勝・**×${game.multiplier}** で降りました。\n${coins(won, settings)} を獲得！`,
        fields: [
          { name: '賭け金', value: `${game.bet.toLocaleString('ja-JP')}`, inline: true },
          { name: '所持金', value: coins(balance, settings), inline: true },
        ],
      }),
    ],
    components: [row(button(id('hl', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
  });
}

export const actions = { open, bet, custom, amount, pick, stop };
