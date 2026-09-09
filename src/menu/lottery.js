/**
 * キャリーオーバー宝くじ。
 * 1枚100コインで3桁の数字を予想し、毎週日曜の夜に抽選する。
 */
import {
  DRAW_HOUR,
  MAX_TICKETS_PER_USER,
  TICKET_PRICE,
  buyTicket,
  drawKeyFor,
  formatNumber,
  getLottery,
  myTickets,
  parseNumber,
  poolOf,
  recentDraws,
} from '../lib/lottery.js';
import { getBalance } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { modal, textInput } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import {
  backButton,
  button,
  embed,
  homeButton,
  id,
  openModal,
  readText,
  row,
  show,
  withNotice,
} from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji(ix.guildId);
  const lottery = await getLottery(ctx.db, ix.guildId);
  const drawKey = drawKeyFor(ctx.calendar);

  const [{ tickets, pool }, mine, balance, history] = await Promise.all([
    poolOf(ctx.db, ix.guildId, drawKey),
    myTickets(ctx.db, ix.guildId, drawKey, ix.userId),
    getBalance(ctx.db, ix.guildId, ix.userId),
    recentDraws(ctx.db, ix.guildId, 3),
  ]);

  const jackpot = pool + lottery.carryover;
  const mineText = mine.length > 0 ? mine.map((row) => `\`${formatNumber(row.number)}\``).join(' ') : 'まだ買っていません';

  const fields = [
    { name: '今回の賞金', value: `**${coins(jackpot, settings)}**`, inline: true },
    { name: '持ち越し', value: `${lottery.carryover.toLocaleString('ja-JP')}`, inline: true },
    { name: '売れた枚数', value: `${tickets} 枚`, inline: true },
    { name: `あなたの番号（${mine.length}/${MAX_TICKETS_PER_USER}）`, value: mineText },
  ];
  if (history.length > 0) {
    fields.push({
      name: '最近の抽選',
      value: history
        .map((draw) =>
          draw.winner_id
            ? `${draw.draw_key}　\`${formatNumber(draw.number)}\`　🎉 <@${draw.winner_id}> が ${draw.prize.toLocaleString('ja-JP')}`
            : `${draw.draw_key}　\`${formatNumber(draw.number)}\`　該当なし（持ち越し）`,
        )
        .join('\n'),
    });
  }

  const closed = !lottery.enabled || !lottery.channel_id;

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x16a085,
          title: `${em.lottery} キャリーオーバー宝くじ`,
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            `**1枚 ${TICKET_PRICE} コイン**で **000〜999** の数字を予想します。\n` +
            `当たれば、集まった額と**これまでの持ち越しをまるごと総取り**。\n` +
            `外れが続くほど賞金は膨らみます。\n\n` +
            `**同じ数字は1人しか買えません**（早い者勝ち）。1人 ${MAX_TICKETS_PER_USER} 枚まで。\n` +
            `抽選は **毎週日曜の ${DRAW_HOUR}時**（今回の抽選日: ${drawKey}）` +
            (closed ? '\n\n⚠️ まだ発表チャンネルが設定されていないため、抽選は行われません。' : ''),
          fields,
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('lot', 'buy'), '番号を買う', {
          emoji: '🎟️',
          style: ButtonStyle.SUCCESS,
          disabled: mine.length >= MAX_TICKETS_PER_USER,
        }),
        button(id('lot', 'lucky'), 'おまかせで買う', {
          emoji: '🎲',
          style: ButtonStyle.PRIMARY,
          disabled: mine.length >= MAX_TICKETS_PER_USER,
        }),
      ),
      row(backButton('games'), homeButton()),
    ],
  });
}

export function buy() {
  return openModal(
    modal(id('lot', 'save'), '宝くじを買う', [
      textInput('number', '3桁の数字（000〜999）', { placeholder: '例: 777', required: true, max: 3 }),
    ]),
  );
}

export async function save(ix, _args, ctx) {
  const parsed = parseNumber(readText(ix, 'number'));
  if (!parsed.ok) return open(ix, [], ctx, parsed.message);
  return purchase(ix, ctx, parsed.number);
}

/** 空いている番号をランダムに1つ選んで買う。 */
export async function lucky(ix, _args, ctx) {
  const drawKey = drawKeyFor(ctx.calendar);
  for (let attempt = 0; attempt < 20; attempt++) {
    const number = Math.floor(Math.random() * 1000);
    const taken = await ctx.db.get(
      'SELECT 1 AS hit FROM lottery_tickets WHERE guild_id = ?1 AND draw_key = ?2 AND number = ?3',
      ix.guildId,
      drawKey,
      number,
    );
    if (!taken) return purchase(ix, ctx, number);
  }
  return open(ix, [], ctx, '空いている番号を見つけられませんでした。番号を指定して買ってください。');
}

async function purchase(ix, ctx, number) {
  const drawKey = drawKeyFor(ctx.calendar);
  const result = await buyTicket(ctx.db, ix.guildId, drawKey, ix.userId, number);

  if (!result.ok) {
    const messages = {
      taken: `\`${formatNumber(number)}\` はもう誰かが買っています。別の数字を選んでください。`,
      limit: `1人 ${MAX_TICKETS_PER_USER} 枚までです。`,
      insufficient: `残高が足りません（1枚 ${TICKET_PRICE} コイン）。`,
      range: '000〜999 の数字を入れてください。',
    };
    return open(ix, [], ctx, messages[result.reason] ?? '買えませんでした。');
  }

  const settings = await ctx.settings(ix.guildId);
  const em = await ctx.emoji(ix.guildId);
  ctx.announce(ix.channelId, {
    content: `${em.lottery} <@${ix.userId}> が宝くじを1枚買いました（${coins(TICKET_PRICE, settings)}）。`,
  });
  return open(ix, [], ctx, `\`${formatNumber(number)}\` を買いました！`);
}

export const actions = { open, buy, save, lucky };
