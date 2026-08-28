import {
  betOf,
  closePoll,
  getPollById,
  optionsOf,
  placeBet,
  settlePoll,
  tally,
} from '../lib/polls.js';
import { getSettings } from '../lib/economy.js';
import { coins, truncate } from '../lib/format.js';
import { button, embed, modal, row, stringSelect, textInput } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { modalResponse, reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `pl:` 始まり。 */
export const namespace = 'pl';

const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪'];

/** お題の掲示板。参加状況が一目で分かるようにする。 */
export async function boardPayload(db, poll, settings) {
  const [options, counts] = await Promise.all([optionsOf(db, poll.id), tally(db, poll.id)]);

  const lines = options.map((option) => {
    const stat = counts.byOption.get(option.idx);
    const detail = stat ? `${stat.count}人 / ${settings.currency_emoji}${stat.total}` : 'まだ誰もいません';
    const mark = poll.answer === option.idx ? '　✅ **正解**' : '';
    return `${LETTERS[option.idx]} **${option.label}** — ${detail}${mark}`;
  });

  const open = poll.status === 'open';
  const fields = [
    { name: '集まった額', value: coins(counts.total, settings), inline: true },
    { name: '参加者', value: `${counts.players} 人`, inline: true },
  ];
  if (poll.mode === 'fixed') fields.push({ name: '参加費', value: `${poll.stake}`, inline: true });
  if (open) fields.push({ name: '締切', value: `<t:${Math.floor(poll.closes_at / 1000)}:R>`, inline: true });

  return {
    embeds: [
      embed({
        color: open ? 0x9b59b6 : 0x95a5a6,
        title: `🗳️ ${truncate(poll.question, 100)}`,
        description:
          lines.join('\n') +
          (open
            ? '\n\n選択肢のボタンを押して参加してください。**1人1つ、あとから変更はできません。**'
            : '\n\n締め切りました。出題者が正解を決めるのを待っています。'),
        fields,
        footer: {
          text: open
            ? poll.mode === 'free'
              ? '賭けた額に比例して山分けします'
              : '正解者で等分します'
            : '出題者だけが正解を決められます',
        },
      }),
    ],
    components: open ? openButtons(poll, options) : closedButtons(poll),
  };
}

function openButtons(poll, options) {
  return [
    row(
      ...options.map((option) =>
        button(`pl:bet:${poll.id}:${option.idx}`, truncate(option.label, 40), {
          emoji: LETTERS[option.idx],
          style: ButtonStyle.PRIMARY,
        }),
      ),
    ),
    row(button(`pl:close:${poll.id}`, '締め切る（出題者）', { emoji: '🔒', style: ButtonStyle.SECONDARY })),
  ];
}

function closedButtons(poll) {
  return [row(button(`pl:answer:${poll.id}`, '正解を決める（出題者）', { emoji: '✅', style: ButtonStyle.SUCCESS }))];
}

export async function handleComponent(ix, ctx) {
  const [, action, rawId, rawOption] = ix.customId.split(':');
  const poll = await getPollById(ctx.db, Number(rawId));
  if (!poll) return reply({ content: 'この予想大会は見つかりませんでした。' });
  if (poll.guild_id !== ix.guildId) return reply({ content: 'この予想大会はこのサーバーのものではありません。' });

  if (action === 'bet') return handleBet(ix, ctx, poll, Number(rawOption));
  if (action === 'amount') return handleAmount(ix, ctx, poll, Number(rawOption));
  if (action === 'close') return handleClose(ix, ctx, poll);
  if (action === 'answer') return handleAnswer(ix, ctx, poll);
  if (action === 'settle') return handleSettle(ix, ctx, poll);
  return reply({ content: '不明な操作です。' });
}

async function handleBet(ix, ctx, poll, optionIdx) {
  if (poll.status !== 'open') return reply({ content: 'この予想大会はもう締め切られています。' });
  if (await betOf(ctx.db, poll.id, ix.userId)) {
    return reply({ content: 'すでに参加しています。あとから選び直すことはできません。' });
  }

  if (poll.mode === 'fixed') return finishBet(ix, ctx, poll, optionIdx, poll.stake);

  const options = await optionsOf(ctx.db, poll.id);
  return modalResponse(
    modal(`pl:amount:${poll.id}:${optionIdx}`, truncate(`「${options[optionIdx]?.label ?? ''}」に賭ける`, 44), [
      textInput('amount', '賭ける額', { placeholder: '例: 200', required: true, max: 12 }),
    ]),
  );
}

async function handleAmount(ix, ctx, poll, optionIdx) {
  const raw = ix.field('amount').trim();
  const normalized = raw
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, '');
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
    return reply({ content: `「${raw}」は金額として読めませんでした。数字で入れてください。` });
  }
  return finishBet(ix, ctx, poll, optionIdx, Number(normalized));
}

async function finishBet(ix, ctx, poll, optionIdx, amount) {
  const settings = await getSettings(ctx.db, poll.guild_id);
  const result = await placeBet(ctx.db, poll, ix.userId, optionIdx, amount);

  if (!result.ok) {
    const messages = {
      closed: 'この予想大会はもう締め切られています。',
      already: 'すでに参加しています。あとから選び直すことはできません。',
      insufficient: '残高が足りません。',
    };
    return reply({ content: messages[result.reason] ?? '参加できませんでした。' });
  }

  const fresh = await getPollById(ctx.db, poll.id);
  return update(await boardPayload(ctx.db, fresh, settings));
}

async function handleClose(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '締め切れるのは出題者だけです。' });
  if (!(await closePoll(ctx.db, poll.id))) return reply({ content: 'すでに締め切られています。' });

  const settings = await getSettings(ctx.db, poll.guild_id);
  const fresh = await getPollById(ctx.db, poll.id);
  return update(await boardPayload(ctx.db, fresh, settings));
}

async function handleAnswer(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '正解を決められるのは出題者だけです。' });
  if (poll.status === 'settled') return reply({ content: 'この予想大会はもう終わっています。' });

  const options = await optionsOf(ctx.db, poll.id);
  return update({
    embeds: [
      embed({
        color: 0x9b59b6,
        title: `🗳️ ${truncate(poll.question, 100)}`,
        description: '**正解はどれですか？** 選ぶとすぐに山分けされます。',
      }),
    ],
    components: [
      stringSelect(
        `pl:settle:${poll.id}`,
        '正解の選択肢を選ぶ',
        options.map((option) => ({
          label: truncate(option.label, 100),
          value: String(option.idx),
          emoji: LETTERS[option.idx],
        })),
      ),
    ],
  });
}

async function handleSettle(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '正解を決められるのは出題者だけです。' });
  const answerIdx = Number(ix.values[0]);
  const settings = await getSettings(ctx.db, poll.guild_id);
  const options = await optionsOf(ctx.db, poll.id);
  const result = await settlePoll(ctx.db, poll, answerIdx);
  if (!result.settled) return reply({ content: 'この予想大会はもう終わっています。' });

  return update(resultPayload(poll, options, answerIdx, result, settings));
}

/** 結果発表。 */
export function resultPayload(poll, options, answerIdx, result, settings) {
  const lines = [`正解は ${LETTERS[answerIdx]} **${options[answerIdx]?.label ?? '—'}**！`, ''];

  if (result.refunded) {
    lines.push(
      result.total > 0
        ? '正解者がいなかった（または参加者が1人だけだった）ので、**全員に返金**しました。'
        : '誰も参加しませんでした。',
    );
  } else {
    lines.push(`集まった ${coins(result.total, settings)} を山分けしました。`, '');
    for (const payout of result.payouts.sort((a, b) => b.amount - a.amount)) {
      const diff = payout.amount - payout.staked;
      lines.push(`<@${payout.userId}>　${payout.staked} → **${payout.amount}**（${diff >= 0 ? '+' : ''}${diff}）`);
    }
  }

  return {
    content: '',
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `🏆 ${truncate(poll.question, 100)}`,
        description: lines.join('\n'),
        footer: { text: '予想大会' },
      }),
    ],
    components: [],
  };
}
