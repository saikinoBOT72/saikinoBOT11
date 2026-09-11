/**
 * キャリーオーバー宝くじ。
 * 1枚100コインで3桁の数字を予想し、毎週日曜の夜に抽選する。
 */
import {
  DRAW_HOUR,
  MAX_TICKETS_PER_USER,
  TICKET_PRICE,
  buyTickets,
  drawKeyFor,
  formatNumber,
  getLottery,
  myTickets,
  parseNumbers,
  pickFreeNumbers,
  poolOf,
  recentDraws,
} from '../lib/lottery.js';
import { getBalance } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { modal, textInput } from '../discord/builders.js';
import { ButtonStyle, TextInputStyle } from '../discord/constants.js';
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
import { EMOJI as em } from '../lib/emoji.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
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
    { name: '今回の賞金', value: coins(jackpot, settings), inline: true },
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
  const left = MAX_TICKETS_PER_USER - mine.length;
  const full = left <= 0;

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
            '番号はまとめて指定できます（例: `777 123 007`）。\n' +
            `抽選は **毎週日曜の ${DRAW_HOUR}時**（今回の抽選日: ${drawKey}）` +
            (closed ? '\n\n⚠️ まだ発表チャンネルが設定されていないため、抽選は行われません。' : ''),
          fields,
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('lot', 'buy'), '番号を選んで買う', {
          emoji: '🎟️',
          style: ButtonStyle.SUCCESS,
          disabled: full,
        }),
        ...luckyButtons(left, balance),
      ),
      row(backButton('games'), homeButton()),
    ],
  });
}

/**
 * おまかせのボタン。残り枚数と所持金で買える範囲だけ出す。
 * 1枚・5枚・残り全部の3択。
 */
function luckyButtons(left, balance) {
  const affordable = Math.floor(balance / TICKET_PRICE);
  const buyable = Math.min(left, affordable);
  if (buyable <= 0) {
    return [button(id('lot', 'lucky', '1'), 'おまかせ', { emoji: '🎲', style: ButtonStyle.PRIMARY, disabled: true })];
  }

  const counts = [1, 5, buyable].filter((count, index, all) => count <= buyable && all.indexOf(count) === index);
  return counts.map((count) =>
    button(id('lot', 'lucky', String(count)), count === 1 ? 'おまかせ1枚' : `おまかせ${count}枚`, {
      emoji: '🎲',
      style: ButtonStyle.PRIMARY,
    }),
  );
}

export function buy() {
  return openModal(
    modal(id('lot', 'save'), '宝くじを買う', [
      textInput('numbers', `3桁の数字（最大${MAX_TICKETS_PER_USER}個・空白かカンマ区切り）`, {
        style: TextInputStyle.PARAGRAPH,
        placeholder: '例: 777 123 007',
        required: true,
        max: 200,
      }),
    ]),
  );
}

export async function save(ix, _args, ctx) {
  const { numbers, errors } = parseNumbers(readText(ix, 'numbers'));
  if (numbers.length === 0) {
    return open(ix, [], ctx, errors[0] ?? '000〜999 の数字を入れてください（例: `777 123`）。');
  }
  return purchase(ix, ctx, numbers, errors);
}

/** 空いている番号をランダムに選んで買う。 */
export async function lucky(ix, [count], ctx) {
  const wanted = Math.min(Math.max(1, Number(count) || 1), MAX_TICKETS_PER_USER);
  const drawKey = drawKeyFor(ctx.calendar);
  const numbers = await pickFreeNumbers(ctx.db, ix.guildId, drawKey, wanted);

  if (numbers.length === 0) {
    return open(ix, [], ctx, '空いている番号を見つけられませんでした。番号を指定して買ってください。');
  }
  return purchase(ix, ctx, numbers);
}

async function purchase(ix, ctx, numbers, inputErrors = []) {
  const drawKey = drawKeyFor(ctx.calendar);
  const { bought, failed } = await buyTickets(ctx.db, ix.guildId, drawKey, ix.userId, numbers);
  const settings = await ctx.settings(ix.guildId);

  const notes = [...inputErrors];
  for (const miss of failed) {
    const reasons = {
      taken: `\`${formatNumber(miss.number)}\` はもう誰かが買っています`,
      limit: `1人 ${MAX_TICKETS_PER_USER} 枚までなので、ここで打ち切りました`,
      insufficient: '残高が足りなくなったので、ここで打ち切りました',
      range: `\`${miss.number}\` は範囲外です`,
    };
    notes.push(reasons[miss.reason] ?? `\`${formatNumber(miss.number)}\` は買えませんでした`);
  }

  if (bought.length === 0) {
    return open(ix, [], ctx, notes.join('\n') || '買えませんでした。');
  }

  const spent = bought.length * TICKET_PRICE;
  ctx.announce(ix.channelId, {
    content: `${em.lottery} <@${ix.userId}> が宝くじを${bought.length}枚買いました（${coins(spent, settings)}）。`,
  });

  const list = bought.map((number) => `\`${formatNumber(number)}\``).join(' ');
  const headline = `${list} を買いました！（${coins(spent, settings)}）`;
  return open(ix, [], ctx, [headline, ...notes].join('\n'));
}

export const actions = { open, buy, save, lucky };
