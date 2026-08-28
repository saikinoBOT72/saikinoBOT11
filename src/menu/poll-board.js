import {
  addBonus,
  betOf,
  cancelPoll,
  closePoll,
  getPollById,
  optionsOf,
  placeBet,
  raiseBet,
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

const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯'];

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
  const bonus = poll.bonus ?? 0;
  const fields = [
    { name: '賞金プール', value: coins(counts.total + bonus, settings), inline: true },
    { name: '参加者', value: `${counts.players} 人`, inline: true },
  ];
  if (bonus > 0) fields.push({ name: '出題者の上乗せ', value: `${bonus.toLocaleString('ja-JP')}`, inline: true });
  if (poll.mode === 'fixed') fields.push({ name: '参加費', value: `${poll.stake}`, inline: true });
  if (open) {
    fields.push({
      name: '締切',
      value: poll.open_ended ? '出題者が締め切るまで' : `<t:${Math.floor(poll.closes_at / 1000)}:R>`,
      inline: true,
    });
  }

  return {
    embeds: [
      embed({
        color: open ? 0x9b59b6 : 0x95a5a6,
        title: `🗳️ ${truncate(poll.question, 100)}`,
        description:
          lines.join('\n') +
          (open
            ? '\n\n選択肢のボタンを押して参加してください。**選び直しや取り消しはできません**が、' +
              (poll.mode === 'free' ? '同じ選択肢になら**あとから上乗せ**できます。' : '参加費制なので全員同じ額です。')
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

/** 選択肢のボタンは1行5つまで。10個まで置けるので2行に折り返す。 */
function optionRows(poll, options) {
  const rows = [];
  for (let i = 0; i < options.length; i += 5) {
    rows.push(
      row(
        ...options.slice(i, i + 5).map((option) =>
          button(`pl:bet:${poll.id}:${option.idx}`, truncate(option.label, 40), {
            emoji: LETTERS[option.idx],
            style: ButtonStyle.PRIMARY,
          }),
        ),
      ),
    );
  }
  return rows;
}

function openButtons(poll, options) {
  return [
    ...optionRows(poll, options),
    row(
      button(`pl:close:${poll.id}`, '締め切る（出題者）', { emoji: '🔒', style: ButtonStyle.SECONDARY }),
      button(`pl:boost:${poll.id}`, '賞金を上乗せ（出題者）', { emoji: '💰', style: ButtonStyle.SECONDARY }),
      button(`pl:cancel:${poll.id}`, '中止（出題者）', { emoji: '🚫', style: ButtonStyle.DANGER }),
    ),
  ];
}

function closedButtons(poll) {
  return [
    row(
      button(`pl:answer:${poll.id}`, '正解を決める（出題者）', { emoji: '✅', style: ButtonStyle.SUCCESS }),
      button(`pl:boost:${poll.id}`, '賞金を上乗せ（出題者）', { emoji: '💰', style: ButtonStyle.SECONDARY }),
      button(`pl:cancel:${poll.id}`, '中止（出題者）', { emoji: '🚫', style: ButtonStyle.DANGER }),
    ),
  ];
}

/** 中止・取り消しのあとの掲示板。 */
export function cancelledPayload(poll, reason) {
  return {
    content: '',
    embeds: [
      embed({
        color: 0x95a5a6,
        title: `🚫 ${truncate(poll.question, 100)}`,
        description: reason,
      }),
    ],
    components: [],
  };
}

export async function handleComponent(ix, ctx) {
  const [, action, rawId, rawOption] = ix.customId.split(':');
  const poll = await getPollById(ctx.db, Number(rawId));
  if (!poll) return reply({ content: 'この予想大会は見つかりませんでした。' });
  if (poll.guild_id !== ix.guildId) return reply({ content: 'この予想大会はこのサーバーのものではありません。' });

  if (action === 'bet') return handleBet(ix, ctx, poll, Number(rawOption));
  if (action === 'amount') return handleAmount(ix, ctx, poll, Number(rawOption));
  if (action === 'close') return handleClose(ix, ctx, poll);
  if (action === 'boost') return handleBoost(ix, ctx, poll);
  if (action === 'bonus') return handleBonus(ix, ctx, poll);
  if (action === 'cancel') return handleCancel(ix, ctx, poll);
  if (action === 'cancelok') return handleCancelOk(ix, ctx, poll);
  if (action === 'answer') return handleAnswer(ix, ctx, poll);
  if (action === 'settle') return handleSettle(ix, ctx, poll);
  return reply({ content: '不明な操作です。' });
}

async function handleBet(ix, ctx, poll, optionIdx) {
  if (poll.status === 'cancelled') return reply({ content: 'この予想大会は中止されました。' });
  if (poll.status !== 'open') return reply({ content: 'この予想大会はもう締め切られています。' });

  const existing = await betOf(ctx.db, poll.id, ix.userId);
  if (existing && existing.option_idx !== optionIdx) {
    return reply({ content: 'すでに別の選択肢に賭けています。あとから選び直すことはできません。' });
  }
  if (existing && poll.mode === 'fixed') {
    return reply({ content: '参加費を決めた大会なので、全員同じ額です。上乗せはできません。' });
  }
  if (poll.mode === 'fixed') return finishBet(ix, ctx, poll, optionIdx, poll.stake);

  const options = await optionsOf(ctx.db, poll.id);
  const label = options[optionIdx]?.label ?? '';
  return modalResponse(
    modal(
      `pl:amount:${poll.id}:${optionIdx}`,
      truncate(existing ? `「${label}」に上乗せする` : `「${label}」に賭ける`, 44),
      [
        textInput('amount', existing ? `追加で賭ける額（いま ${existing.amount}）` : '賭ける額', {
          placeholder: '例: 200',
          required: true,
          max: 12,
        }),
      ],
    ),
  );
}

async function handleAmount(ix, ctx, poll, optionIdx) {
  const amount = readAmount(ix);
  if (amount === null) {
    return reply({ content: `「${ix.field('amount').trim()}」は金額として読めませんでした。数字で入れてください。` });
  }
  return finishBet(ix, ctx, poll, optionIdx, amount);
}

async function finishBet(ix, ctx, poll, optionIdx, amount) {
  const settings = await getSettings(ctx.db, poll.guild_id);
  const existing = await betOf(ctx.db, poll.id, ix.userId);

  // 同時に押されて「先に入っていた」ときは、そのまま上乗せに切り替える
  let result = existing
    ? await raiseBet(ctx.db, poll, ix.userId, optionIdx, amount)
    : await placeBet(ctx.db, poll, ix.userId, optionIdx, amount);
  if (!result.ok && result.reason === 'already') {
    result = await raiseBet(ctx.db, poll, ix.userId, optionIdx, amount);
  }

  if (!result.ok) {
    const messages = {
      closed: 'この予想大会はもう締め切られています。',
      other: 'すでに別の選択肢に賭けています。あとから選び直すことはできません。',
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

/** 出題者が自腹で賞金を上乗せする。 */
async function handleBoost(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '賞金を上乗せできるのは出題者だけです。' });
  if (poll.status !== 'open' && poll.status !== 'closed') {
    return reply({ content: 'この予想大会はもう終わっています。' });
  }

  return modalResponse(
    modal(`pl:bonus:${poll.id}`, '賞金を上乗せする', [
      textInput('amount', '上乗せする額', { placeholder: '例: 1000', required: true, max: 12 }),
    ]),
  );
}

async function handleBonus(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '賞金を上乗せできるのは出題者だけです。' });

  const amount = readAmount(ix);
  if (amount === null) return reply({ content: '上乗せする額は数字で入れてください。' });

  const result = await addBonus(ctx.db, poll, amount);
  if (!result.ok) {
    const messages = {
      closed: 'この予想大会はもう終わっています。',
      insufficient: '残高が足りません。',
    };
    return reply({ content: messages[result.reason] ?? '上乗せできませんでした。' });
  }

  const settings = await getSettings(ctx.db, poll.guild_id);
  const fresh = await getPollById(ctx.db, poll.id);
  ctx.announce(poll.channel_id, {
    content: `💰 <@${poll.owner_id}> が賞金に ${coins(amount, settings)} 上乗せしました！（上乗せ合計 ${result.bonus}）`,
  });
  return update(await boardPayload(ctx.db, fresh, settings));
}

/** 中止は取り返しがつかないので、本人にだけ確認を出す。 */
async function handleCancel(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '中止できるのは出題者だけです。' });
  if (poll.status !== 'open' && poll.status !== 'closed') {
    return reply({ content: 'この予想大会はもう終わっています。' });
  }

  const settings = await getSettings(ctx.db, poll.guild_id);
  const counts = await tally(ctx.db, poll.id);
  return reply({
    embeds: [
      embed({
        color: 0xe74c3c,
        title: '🚫 この予想大会を中止しますか？',
        description:
          `**${truncate(poll.question, 80)}**\n\n` +
          `参加した ${counts.players} 人に ${coins(counts.total, settings)} を返します。` +
          (poll.bonus > 0 ? `\n上乗せした ${coins(poll.bonus, settings)} もあなたに戻ります。` : ''),
      }),
    ],
    components: [
      row(
        button(`pl:cancelok:${poll.id}`, '中止する', { emoji: '🚫', style: ButtonStyle.DANGER }),
      ),
    ],
  });
}

async function handleCancelOk(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '中止できるのは出題者だけです。' });
  if (!(await cancelPoll(ctx.db, poll))) return reply({ content: 'この予想大会はもう終わっています。' });

  // 押されたのは本人にしか見えない確認メッセージなので、掲示板は別途書き換える
  if (poll.message_id) {
    ctx.waitUntil(
      ctx.rest
        .editMessage(
          poll.channel_id,
          poll.message_id,
          cancelledPayload(poll, '出題者が中止しました。賭けた額は全員に返しました。'),
        )
        .catch((error) => console.error('予想大会の中止表示に失敗:', error)),
    );
  }

  return update({
    embeds: [embed({ color: 0x95a5a6, title: '🚫 中止しました', description: '賭けた額は全員に返しました。' })],
    components: [],
  });
}

/** 全角やカンマ混じりでも読めるようにする。 */
function readAmount(ix) {
  const normalized = ix
    .field('amount')
    .trim()
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, '');
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1) return null;
  return Number(normalized);
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
        ? '正解者がいなかった（または参加者が1人だけだった）ので、**全員に返金**しました。' +
          (result.bonus > 0 ? '上乗せぶんは出題者に戻しました。' : '')
        : '誰も参加しませんでした。',
    );
  } else {
    lines.push(
      `賞金プール ${coins(result.total, settings)}` +
        (result.bonus > 0 ? `（うち出題者の上乗せ ${result.bonus.toLocaleString('ja-JP')}）` : '') +
        ' を山分けしました。',
      '',
    );
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
