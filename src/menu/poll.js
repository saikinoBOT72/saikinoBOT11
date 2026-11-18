import {
  MAX_MINUTES,
  MAX_OPTIONS,
  MIN_MINUTES,
  JUDGES,
  MIN_OPTIONS,
  MODES,
  createPoll,
  listPolls,
  tally,
} from '../lib/polls.js';
import { boardPayload } from './poll-board.js';
import { cleanLine } from '../lib/text.js';
import { gameChannelOf } from '../lib/guild-prefs.js';
import { coins, truncate } from '../lib/format.js';
import { linkButton, modal, selectField, textInput } from '../discord/builders.js';
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
    const state =
      poll.status !== 'open'
        ? '締切済み・正解待ち'
        : poll.open_ended
          ? '締切なし'
          : `締切 <t:${Math.floor(poll.closes_at / 1000)}:R>`;
    const pot = counts.total + (poll.bonus ?? 0);
    const boost = poll.bonus > 0 ? `（うち上乗せ ${poll.bonus}）` : '';
    lines.push(`🗳️ **${truncate(poll.question, 60)}** — ${counts.players}人 / ${coins(pot, settings)}${boost}（${state}）`);
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
            { name: '進め方', value: 'お題を立てる → みんなが賭ける → 締切 → **出題者（または管理者）が正解を決める** → 山分け' },
            {
              name: '決まりごと',
              value: [
                '・1人1つ。選び直しや取り消しはできませんが、**同じ選択肢への上乗せ**はできます',
                '・締切は分で指定。空欄なら **出題者が締め切るまで** 受け付けます',
                `・選択肢は ${MIN_OPTIONS}〜${MAX_OPTIONS} 個`,
                '・正解者がいなければ全員に返金',
                '・参加者が1人だけなら不成立で返金',
                '・出題者も賭けられます（そのときは掲示板に表示されます）。正解を **管理者に任せる** こともできます',
                '・掲示板の「当たれば ×◯」は、いま締め切ったときの倍率の目安です',
                '・出題者は **自腹で賞金を上乗せ**できます（不成立・中止なら戻ります）',
                '・出題者はいつでも **中止**できます（全額返金）',
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

export async function newPoll(ix, _args, ctx) {
  const modern = Boolean((await ctx.settings(ix.guildId)).modern_ui);
  // 新しい見た目なら「正解を決める人」をリストから選べる。古い形では文字で書いてもらう
  const judge = modern
    ? selectField(
        'judge',
        '正解を決める人',
        [
          { label: '自分（出題者）', value: 'owner', emoji: '🙋', default: true },
          { label: 'サーバー管理者に任せる', value: 'admin', emoji: '🛡️', description: '自分も賭けたいときに' },
        ],
        { description: '自分も賭けるなら、管理者に任せると公平です' },
      )
    : textInput('judge', '正解を決める人（空欄なら自分。任せるなら「管理者」）', { placeholder: '管理者', max: 10 });
  return openModal(
    modal(id('poll', 'create'), '予想大会のお題を立てる', [
      textInput('question', 'お題', { placeholder: '例: 今日の飲み会、Aさんは来る？', required: true, max: 100 }),
      textInput('options', `選択肢（改行で区切って ${MIN_OPTIONS}〜${MAX_OPTIONS} 個）`, {
        style: TextInputStyle.PARAGRAPH,
        placeholder: '来る\n来ない\n遅れて来る',
        required: true,
        max: 600,
      }),
      textInput('minutes', '締切まで何分か（空欄なら締切なし）', { placeholder: '例: 60', max: 6 }),
      textInput('stake', '参加費（空欄なら好きな額を賭けられる）', { placeholder: '例: 100', max: 12 }),
      judge,
    ], { labeled: modern }),
  );
}

export async function create(ix, _args, ctx) {
  const question = readText(ix, 'question', { line: true });
  const rawOptions = readText(ix, 'options');
  const minutes = readInt(ix, 'minutes', { min: MIN_MINUTES, max: MAX_MINUTES });
  const stake = readInt(ix, 'stake', { min: 1, fallback: 0 });
  const picked = ix.fieldValues('judge')[0];
  const judge = picked
    ? (picked === 'admin' ? 'admin' : 'owner')
    : /管理|admin/i.test(readText(ix, 'judge', { line: true, max: 10 }) ?? '') ? 'admin' : 'owner';

  if (!question) return open(ix, [], ctx, 'お題を入力してください。');
  if (isError(minutes)) return open(ix, [], ctx, minutes.error);
  if (isError(stake)) return open(ix, [], ctx, stake.error);

  const options = (rawOptions ?? '')
    .split('\n')
    .map((line) => cleanLine(line, { max: 80 }))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  if (options.length < MIN_OPTIONS) {
    return open(ix, [], ctx, `選択肢は改行で区切って ${MIN_OPTIONS} 個以上入れてください。`);
  }

  const settings = await ctx.settings(ix.guildId);
  const poll = await createPoll(ctx.db, {
    guildId: ix.guildId,
    channelId: gameChannelOf(settings, ix.channelId),
    ownerId: ix.userId,
    question,
    options,
    mode: stake > 0 ? 'fixed' : 'free',
    stake: stake ?? 0,
    minutes,
    judge,
  });

  const board = await boardPayload(ctx.db, poll, settings);
  let posted;
  try {
    posted = await ctx.rest.createMessage(poll.channel_id, board);
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
          `**${truncate(question, 80)}**\n\nチャンネルに投稿しました。` +
          (poll.open_ended
            ? '締切はありません（**🔒 締め切る** を押すまで受け付けます）。\n'
            : `締切は <t:${Math.floor(poll.closes_at / 1000)}:R> です。\n`) +
          `${MODES[poll.mode].label}（${MODES[poll.mode].hint}）\n` +
          `正解を決める人：**${JUDGES[poll.judge].label}**（${JUDGES[poll.judge].hint}）\n\n` +
          (poll.judge === 'admin'
            ? '締切がきたら、サーバー管理者が投稿の **✅ 正解を決める** から正解を選びます。\n'
            : '締切がきたら、投稿の **✅ 正解を決める** から正解を選んでください。\n') +
          '**💰 賞金を上乗せ** で自腹を切って盛り上げたり、**🚫 中止** で取りやめたりもできます。',
      }),
    ],
    components: [
      row(
        linkButton(`https://discord.com/channels/${ix.guildId}/${poll.channel_id}/${posted.id}`, '掲示板へ移動', { emoji: '↗️' }),
        button(id('poll', 'open'), '予想大会へ', { emoji: '🗳️' }),
        homeButton(),
      ),
    ],
  });
}

export const actions = { open, new: newPoll, create };
