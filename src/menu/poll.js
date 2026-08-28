import {
  MAX_MINUTES,
  MAX_OPTIONS,
  MIN_MINUTES,
  MIN_OPTIONS,
  MODES,
  createPoll,
  listPolls,
  tally,
} from '../lib/polls.js';
import { boardPayload } from './poll-board.js';
import { coins, truncate } from '../lib/format.js';
import { modal, textInput } from '../discord/builders.js';
import { ButtonStyle, TextInputStyle } from '../discord/constants.js';
import {
  backButton,
  button,
  embed,
  homeButton,
  id,
  isError,
  openModal,
  readInt,
  readText,
  row,
  show,
  withNotice,
} from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const polls = await listPolls(ctx.db, ix.guildId);

  const lines = [];
  for (const poll of polls) {
    const counts = await tally(ctx.db, poll.id);
    const state = poll.status === 'open' ? `締切 <t:${Math.floor(poll.closes_at / 1000)}:R>` : '締切済み・正解待ち';
    lines.push(`🗳️ **${truncate(poll.question, 60)}** — ${counts.players}人 / ${coins(counts.total, settings)}（${state}）`);
  }

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x9b59b6,
          title: '🗳️ 予想大会',
          description:
            'お題と選択肢を立てて、みんなで賭けるゲームです。\n' +
            '**集まった全額を正解者で山分け**するので、人気のない選択肢を当てるほど儲かります。\n\n' +
            (lines.length > 0 ? `**いま開催中**\n${lines.join('\n')}` : 'いまは開催中の大会がありません。'),
          fields: [
            { name: '進め方', value: 'お題を立てる → みんなが賭ける → 締切 → **出題者が正解を決める** → 山分け' },
            {
              name: '決まりごと',
              value: [
                '・1人1つ、あとから選び直せません',
                '・正解者がいなければ全員に返金',
                '・参加者が1人だけなら不成立で返金',
                '・出題者も賭けられます',
              ].join('\n'),
            },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(button(id('poll', 'new'), 'お題を立てる', { emoji: '🆕', style: ButtonStyle.SUCCESS })),
      row(backButton('games'), homeButton()),
    ],
  });
}

export function newPoll() {
  return openModal(
    modal(id('poll', 'create'), '予想大会のお題を立てる', [
      textInput('question', 'お題', { placeholder: '例: 今日の飲み会、Aさんは来る？', required: true, max: 100 }),
      textInput('options', `選択肢（改行で区切って ${MIN_OPTIONS}〜${MAX_OPTIONS} 個）`, {
        style: TextInputStyle.PARAGRAPH,
        placeholder: '来る\n来ない\n遅れて来る',
        required: true,
        max: 300,
      }),
      textInput('minutes', '締切まで何分か', { placeholder: '例: 60', required: true, max: 6 }),
      textInput('stake', '参加費（空欄なら好きな額を賭けられる）', { placeholder: '例: 100', max: 12 }),
    ]),
  );
}

export async function create(ix, _args, ctx) {
  const question = readText(ix, 'question');
  const rawOptions = readText(ix, 'options');
  const minutes = readInt(ix, 'minutes', { min: MIN_MINUTES, max: MAX_MINUTES });
  const stake = readInt(ix, 'stake', { min: 1, fallback: 0 });

  if (!question) return open(ix, [], ctx, 'お題を入力してください。');
  if (isError(minutes)) return open(ix, [], ctx, minutes.error);
  if (minutes === null) return open(ix, [], ctx, '締切までの分数を入力してください。');
  if (isError(stake)) return open(ix, [], ctx, stake.error);

  const options = (rawOptions ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  if (options.length < MIN_OPTIONS) {
    return open(ix, [], ctx, `選択肢は改行で区切って ${MIN_OPTIONS} 個以上入れてください。`);
  }

  const poll = await createPoll(ctx.db, {
    guildId: ix.guildId,
    channelId: ix.channelId,
    ownerId: ix.userId,
    question,
    options,
    mode: stake > 0 ? 'fixed' : 'free',
    stake: stake ?? 0,
    minutes,
  });

  const settings = await ctx.settings(ix.guildId);
  const board = await boardPayload(ctx.db, poll, settings);
  let posted = null;
  try {
    posted = await ctx.rest.createMessage(ix.channelId, board);
    await ctx.db.run('UPDATE polls SET message_id = ?2 WHERE id = ?1', poll.id, posted.id);
  } catch (error) {
    console.error('予想大会の投稿に失敗:', error);
    await ctx.db.run("UPDATE polls SET status = 'cancelled' WHERE id = ?1", poll.id);
    return open(ix, [], ctx, 'このチャンネルにお題を投稿できませんでした。');
  }

  return show(ix, {
    embeds: [
      embed({
        color: 0x9b59b6,
        title: '🗳️ お題を立てました',
        description:
          `**${truncate(question, 80)}**\n\nチャンネルに投稿しました。締切は <t:${Math.floor(poll.closes_at / 1000)}:R> です。\n` +
          `${MODES[poll.mode].label}（${MODES[poll.mode].hint}）\n\n` +
          '締切がきたら、投稿の **✅ 正解を決める** から正解を選んでください。',
      }),
    ],
    components: [row(button(id('poll', 'open'), '予想大会へ', { emoji: '🗳️' }), homeButton())],
  });
}

export const actions = { open, new: newPoll, create };
