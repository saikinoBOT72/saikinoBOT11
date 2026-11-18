/**
 * 🎫 スクラッチくじ。
 *
 * 買った時点で当たり外れが決まり、精算も済ませる。削るのは見せ方だけ。
 * カードの中身は scratch_cards に置き、ボタンには「どのカードのどのマスか」だけを載せる
 * （ボタンに中身を載せると、細工したボタンで嘘の当たり画面を作れてしまうため）。
 */
import { getBalance, settleWager } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { ALL_REVEALED, SYMBOLS, TIERS, newTicket, winnerOf } from '../lib/scratch.js';
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

const COLOR = 0x9b59b6;

async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLOR,
          title: '🎫 スクラッチ',
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            '9マスを削って、**同じ絵柄が3つ**出たら当たり。当たり外れは買った時点で決まっています。\n\n' +
            '1枚の値段を選んでください。',
          fields: [
            {
              name: '当たり',
              value: TIERS.map((tier) => `${SYMBOLS[tier.symbol].repeat(3)} **×${tier.multiplier}**`).join('\n'),
              inline: true,
            },
          ],
        }),
        notice,
      ),
    ],
    components: amountRows(['scratch', 'buy'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
  });
}

function custom() {
  return openModal(modal(id('scratch', 'amount'), 'スクラッチ', [textInput('amount', '1枚の値段', { placeholder: '例: 100', required: true, max: 12 })]));
}

async function amount(ix, _args, ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return open(ix, [], ctx, value.error);
  return buy(ix, [String(value)], ctx);
}

async function buy(ix, [rawBet], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return open(ix, [], ctx, check.message);

  const ticket = newTicket();
  const payout = bet * ticket.multiplier;
  const settled = await settleWager(ctx.db, ix.guildId, ix.userId, {
    bet,
    payout,
    betReason: 'scratch:bet',
    winReason: 'scratch:win',
    detail: `x${ticket.multiplier}`,
  });
  if (!settled.ok) return open(ix, [], ctx, '残高が足りません。');

  const cardId = crypto.randomUUID();
  await ctx.db.run(
    'INSERT INTO scratch_cards (id, guild_id, user_id, bet, payout, cells, revealed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)',
    cardId,
    ix.guildId,
    ix.userId,
    bet,
    payout,
    JSON.stringify(ticket.cells),
    Date.now(),
  );

  goLive(ctx, ix, settings, {
    net: payout - bet,
    force: ticket.multiplier >= 50,
    embed: embed({
      color: payout > bet ? 0xf1c40f : 0x95a5a6,
      title: ticket.multiplier >= 50 ? '🎉 スクラッチで大当たり！' : payout > bet ? '🎫 スクラッチで大勝ち' : '🎫 スクラッチで大負け',
      description: `<@${ix.userId}> がスクラッチで **×${ticket.multiplier}**`,
    }),
  });

  return cardScreen(ix, ctx, await loadCard(ctx, ix, cardId));
}

async function loadCard(ctx, ix, cardId) {
  return ctx.db.get('SELECT * FROM scratch_cards WHERE id = ?1 AND guild_id = ?2 AND user_id = ?3', cardId, ix.guildId, ix.userId);
}

/** 1マス削る。削った印は足すだけなので、何度押しても同じ。 */
async function dig(ix, [cardId, rawCell], ctx) {
  const cell = Number(rawCell);
  if (!(cell >= 0 && cell < 9)) return open(ix, [], ctx, 'そのマスはありません。');
  await ctx.db.run(
    'UPDATE scratch_cards SET revealed = revealed | ?4 WHERE id = ?1 AND guild_id = ?2 AND user_id = ?3',
    cardId,
    ix.guildId,
    ix.userId,
    1 << cell,
  );
  const card = await loadCard(ctx, ix, cardId);
  if (!card) return open(ix, [], ctx, 'このカードは見つかりませんでした（1日たつと片付けます。結果はもう精算済みです）。');
  return cardScreen(ix, ctx, card);
}

async function all(ix, [cardId], ctx) {
  await ctx.db.run(
    'UPDATE scratch_cards SET revealed = ?4 WHERE id = ?1 AND guild_id = ?2 AND user_id = ?3',
    cardId,
    ix.guildId,
    ix.userId,
    ALL_REVEALED,
  );
  const card = await loadCard(ctx, ix, cardId);
  if (!card) return open(ix, [], ctx, 'このカードは見つかりませんでした（1日たつと片付けます。結果はもう精算済みです）。');
  return cardScreen(ix, ctx, card);
}

async function cardScreen(ix, ctx, card) {
  const settings = await ctx.settings(ix.guildId);
  const cells = JSON.parse(card.cells);
  const done = card.revealed === ALL_REVEALED;
  const winner = winnerOf(cells);

  const grid = [0, 1, 2].map((rowIndex) =>
    row(
      ...[0, 1, 2].map((column) => {
        const index = rowIndex * 3 + column;
        const shown = (card.revealed & (1 << index)) !== 0;
        if (!shown) return button(id('scratch', 'dig', card.id, String(index)), '？', { style: ButtonStyle.SECONDARY });
        const lucky = done && winner !== null && cells[index] === winner;
        return button(id('scratch', 'dig', card.id, String(index)), '\u200B', {
          emoji: SYMBOLS[cells[index]],
          style: lucky ? ButtonStyle.SUCCESS : ButtonStyle.PRIMARY,
          disabled: true,
        });
      }),
    ),
  );

  if (!done) {
    const left = 9 - [...Array(9).keys()].filter((index) => (card.revealed & (1 << index)) !== 0).length;
    return show(ix, {
      embeds: [
        embed({
          color: COLOR,
          title: '🎫 スクラッチ — マスを押して削ろう',
          description: `残り ${left} マス。同じ絵柄が3つ出たら当たりです。`,
          footer: { text: `1枚 ${card.bet.toLocaleString('ja-JP')}（結果はもう決まっています）` },
        }),
      ],
      components: [...grid, row(button(id('scratch', 'all', card.id), '全部けずる', { emoji: '🪙', style: ButtonStyle.SUCCESS }))],
    });
  }

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const multiplier = card.bet > 0 ? card.payout / card.bet : 0;
  return show(ix, {
    ...resultEmbed({
      art: winner !== null ? SYMBOLS[winner].repeat(3) : '',
      verdict: winner !== null ? `🎉 ${SYMBOLS[winner]} が3つ！ ×${multiplier}` : '💧 はずれ',
      color: winner !== null ? 0x2ecc71 : 0x95a5a6,
      detail: winner !== null ? `${coins(card.payout, settings)} を受け取りました。` : '同じ絵柄は3つそろいませんでした。',
      fields: moneyFields(card.bet, card.payout - card.bet, balance, settings, { coins }),
    }),
    components: [
      ...grid,
      row(
        button(id('scratch', 'buy', String(card.bet)), `もう1枚（${card.bet}）`, {
          emoji: '🔁',
          style: ButtonStyle.SUCCESS,
          disabled: balance < card.bet,
        }),
        button(id('scratch', 'open'), '値段を変える', { emoji: '💰' }),
        shareButton(),
        homeButton(),
      ),
    ],
  });
}

/** 1日たったカードを片付ける（定期処理から）。結果はとっくに精算済みなので、消しても困らない。 */
export async function tidyScratchCards(db, now = Date.now()) {
  await db.run('DELETE FROM scratch_cards WHERE created_at < ?1', now - 24 * 3600 * 1000);
}

export const actions = { open, custom, amount, buy, dig, all };
