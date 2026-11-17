import {
  addBonus,
  betOf,
  betsOf,
  cancelPoll,
  closePoll,
  getPollById,
  JUDGES,
  oddsOf,
  optionsOf,
  placeBet,
  raiseBet,
  settlePoll,
  tally,
} from '../lib/polls.js';
import { getSettings } from '../lib/economy.js';
import { coins, truncate } from '../lib/format.js';
import { button, channelSelect, embed, linkButton, modal, row, stringSelect, textInput } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { modalResponse, reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `pl:` 始まり。 */
export const namespace = 'pl';

const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯'];

/** お題の掲示板。参加状況が一目で分かるようにする。 */
export async function boardPayload(db, poll, settings) {
  const [options, counts, bets] = await Promise.all([optionsOf(db, poll.id), tally(db, poll.id), betsOf(db, poll.id)]);

  const open = poll.status === 'open';
  const bonus = poll.bonus ?? 0;
  const pool = counts.total + bonus;
  const byAdmin = poll.judge === 'admin';

  // 誰が何に賭けたかも出す（正解を決める人がいるので、身内の信頼のために見えるようにしておく）
  // 「いま当たったら何倍か」も添える。人気のない選択肢ほど倍率が高い
  const lines = options.map((option) => {
    const stat = counts.byOption.get(option.idx);
    const detail = stat ? `${stat.count}人 / ${settings.currency_emoji}${stat.total}` : 'まだ誰もいません';
    const odds = poll.status === 'settled' ? null : oddsOf(stat, pool, poll.mode);
    const oddsText = !odds
      ? ''
      : odds.multiplier !== undefined
        ? `　*当たれば ×${odds.multiplier.toFixed(odds.multiplier >= 10 ? 0 : 1)}*`
        : `　*当たれば1人 ${odds.share.toLocaleString('ja-JP')}*`;
    const mark = poll.answer === option.idx ? '　✅ **正解**' : '';
    return `${LETTERS[option.idx]} **${option.label}** — ${detail}${oddsText}${mark}${whoBet(bets, option.idx)}`;
  });
  const ownerBet = !byAdmin && bets.some((bet) => bet.user_id === poll.owner_id);
  const fields = [
    { name: '賞金プール', value: coins(pool, settings), inline: true },
    { name: '参加者', value: `${counts.players} 人`, inline: true },
    { name: '正解を決める人', value: byAdmin ? '🛡️ サーバー管理者' : `<@${poll.owner_id}>（出題者）`, inline: true },
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
            : `\n\n締め切りました。${byAdmin ? '管理者' : '出題者'}が正解を決めるのを待っています。`) +
          (ownerBet ? '\n\n⚠️ 出題者もこの大会に賭けています。' : ''),
        fields,
        footer: {
          text: open
            ? poll.mode === 'free'
              ? '賭けた額に比例して山分けします（倍率は締切までに変わります）'
              : '正解者で等分します'
            : byAdmin
              ? '賭けていないサーバー管理者が正解を決めます'
              : '出題者だけが正解を決められます',
        },
      }),
    ],
    components: open ? openButtons(poll, options) : closedButtons(poll),
  };
}

/** その選択肢に賭けた人の一覧（多いときは先頭だけ）。 */
function whoBet(bets, optionIdx) {
  const mine = bets.filter((bet) => bet.option_idx === optionIdx).sort((a, b) => b.amount - a.amount);
  if (mine.length === 0) return '';
  const SHOWN = 6;
  const names = mine.slice(0, SHOWN).map((bet) => `<@${bet.user_id}> ${bet.amount.toLocaleString('ja-JP')}`);
  const rest = mine.length > SHOWN ? `　ほか${mine.length - SHOWN}人` : '';
  return `\n　${names.join('・')}${rest}`;
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
      button(`pl:again:${poll.id}`, '再通知（出題者）', { emoji: '📢', style: ButtonStyle.SECONDARY }),
      button(`pl:cancel:${poll.id}`, '中止', { emoji: '🚫', style: ButtonStyle.DANGER }),
    ),
  ];
}

function closedButtons(poll) {
  return [
    row(
      button(`pl:answer:${poll.id}`, `正解を決める（${JUDGES[poll.judge]?.label ?? '出題者'}）`, {
        emoji: '✅',
        style: ButtonStyle.SUCCESS,
      }),
      button(`pl:boost:${poll.id}`, '賞金を上乗せ（出題者）', { emoji: '💰', style: ButtonStyle.SECONDARY }),
      button(`pl:cancel:${poll.id}`, '中止', { emoji: '🚫', style: ButtonStyle.DANGER }),
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
  if (action === 'pick') return handlePick(ix, ctx, poll);
  if (action === 'settle') return handleSettle(ix, ctx, poll, rawOption);
  if (action === 'again') return handleNotifyPick(ix, poll);
  if (action === 'notify') return handleNotify(ix, ctx, poll, rawOption);
  if (action === 'more') return handleAgain(ix);
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------ 再通知 */

/**
 * 開催中の予想大会を、出題者が選んだチャンネルに知らせ直す。
 *
 * 掲示板は流れて埋もれるので、気づいてほしいときに別の場所へ声をかけられるようにする。
 * 掲示板そのものは動かさない（ボタンが2枚になると集計がちぐはぐに見えるため）。
 * 知らせるほうには中身と、掲示板へ飛ぶボタンだけを置く。
 */
function handleNotifyPick(ix, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '再通知できるのは出題者だけです。' });
  if (poll.status !== 'open') return reply({ content: 'この予想大会はもう締め切られています。' });

  return reply({
    embeds: [
      embed({
        color: 0x9b59b6,
        title: '📢 再通知',
        description: `**${truncate(poll.question, 80)}**\n\nどのチャンネルに知らせますか。`,
      }),
    ],
    components: [channelSelect(`pl:notify:${poll.id}`, '知らせるチャンネルを選ぶ')],
  });
}

async function handleNotify(ix, ctx, poll) {
  if (ix.userId !== poll.owner_id) return reply({ content: '再通知できるのは出題者だけです。' });
  if (poll.status !== 'open') return reply({ content: 'この予想大会はもう締め切られています。' });

  const channelId = ix.values[0];
  const settings = await getSettings(ctx.db, poll.guild_id);
  const [options, counts] = await Promise.all([optionsOf(ctx.db, poll.id), tally(ctx.db, poll.id)]);

  const fields = [
    { name: '賞金プール', value: coins(counts.total + (poll.bonus ?? 0), settings), inline: true },
    { name: '参加者', value: `${counts.players} 人`, inline: true },
    {
      name: '締切',
      value: poll.open_ended ? '出題者が締め切るまで' : `<t:${Math.floor(poll.closes_at / 1000)}:R>`,
      inline: true,
    },
  ];

  // 掲示板へ飛ぶボタン。貼れていない場合（message_id が無い）は付けない
  const jump =
    poll.message_id && `https://discord.com/channels/${poll.guild_id}/${poll.channel_id}/${poll.message_id}`;

  try {
    await ctx.rest.createMessage(channelId, {
      embeds: [
        embed({
          color: 0x9b59b6,
          title: `🗳️ ${truncate(poll.question, 100)}`,
          description:
            `${options.map((option) => `${LETTERS[option.idx]} **${option.label}**`).join('\n')}\n\n` +
            '参加はもとの掲示板から。下のボタンで飛べます。',
          fields,
          footer: { text: '予想大会の再通知' },
        }),
      ],
      components: jump ? [row(linkButton(jump, '掲示板へ行く', { emoji: '🗳️' }))] : [],
    });
  } catch (error) {
    console.error('予想大会の再通知に失敗:', error);
    return reply({ content: `<#${channelId}> に投稿できませんでした。Bot が書き込めるか確認してください。` });
  }

  return reply({ content: `<#${channelId}> に知らせました。` });
}

/**
 * 「もう1問出す」。
 *
 * 予想大会はお題と選択肢を毎回書くものなので、同じ勝負をやり直すことはできない。
 * 代わりに、新しいお題を立てる入口を本人にだけ出す。
 *
 * ここで直にフォームを開かない理由：フォームの送信はメニューの流れに入るため、
 * 押された結果発表のメッセージが「お題を立てました」に書き換わってしまう。
 * いったん本人だけに見えるメッセージをはさめば、書き換わるのはそちらになる。
 */
function handleAgain(ix) {
  return reply({
    embeds: [
      embed({
        color: 0x9b59b6,
        title: '🗳️ もう1問出す',
        description: `<@${ix.userId}> さん、下のボタンから新しいお題を立てられます。`,
      }),
    ],
    components: [row(button('m:poll:new', 'お題を立てる', { emoji: '🆕', style: ButtonStyle.SUCCESS }))],
  });
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
  if (ix.userId !== poll.owner_id && !ix.isAdmin) return reply({ content: '中止できるのは出題者とサーバー管理者だけです。' });
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
          (poll.bonus > 0 ? `\n出題者が上乗せした ${coins(poll.bonus, settings)} も出題者に戻ります。` : ''),
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
  if (ix.userId !== poll.owner_id && !ix.isAdmin) return reply({ content: '中止できるのは出題者とサーバー管理者だけです。' });
  const who = ix.userId === poll.owner_id ? '出題者' : '管理者';
  if (!(await cancelPoll(ctx.db, poll))) return reply({ content: 'この予想大会はもう終わっています。' });

  // 押されたのは本人にしか見えない確認メッセージなので、掲示板は別途書き換える
  if (poll.message_id) {
    ctx.waitUntil(
      ctx.rest
        .editMessage(
          poll.channel_id,
          poll.message_id,
          cancelledPayload(poll, `${who}が中止しました。賭けた額は全員に返しました。`),
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

/**
 * 正解を決める。
 *
 * みんなの掲示板を選択画面に書き換えると、ほかの人からは掲示板が消えたように見え、
 * 出題者が選ぶのをやめると元に戻せない。なので出題者にだけ見えるメッセージで選ばせる。
 * 選んだあと「この選択肢で確定」を押すまでは山分けしない（押し間違いで確定しないように）。
 */
/**
 * 正解を決められるか。出題者の大会は出題者だけ。
 * 管理者に任せた大会は、その大会に賭けていないサーバー管理者だけ（自分に有利な正解を選べないように）。
 * @returns {Promise<string|null>} 決められない理由
 */
async function judgeProblem(ix, ctx, poll) {
  if (poll.judge === 'admin') {
    if (!ix.isAdmin) return 'この大会は、サーバー管理者が正解を決めます。';
    if (await betOf(ctx.db, poll.id, ix.userId)) return '自分が賭けている大会の正解は決められません。ほかの管理者にお願いしてください。';
    return null;
  }
  return ix.userId === poll.owner_id ? null : '正解を決められるのは出題者だけです。';
}

async function handleAnswer(ix, ctx, poll) {
  const problem = await judgeProblem(ix, ctx, poll);
  if (problem) return reply({ content: problem });
  if (poll.status === 'settled' || poll.status === 'cancelled') return reply({ content: 'この予想大会はもう終わっています。' });
  return reply(await answerPayload(ctx, poll));
}

async function answerPayload(ctx, poll, chosen = null) {
  const options = await optionsOf(ctx.db, poll.id);
  const picked = chosen === null ? null : options[chosen];
  return {
    embeds: [
      embed({
        color: 0x9b59b6,
        title: `🗳️ ${truncate(poll.question, 100)}`,
        description: picked
          ? `正解は **${LETTERS[picked.idx]} ${picked.label}** でよいですか？\n` +
            '**確定するとすぐに山分けされ、取り消せません。**'
          : '**正解はどれですか？** 選んだあと、もう一度確かめてから確定します。',
      }),
    ],
    components: [
      stringSelect(
        `pl:pick:${poll.id}`,
        picked ? '選び直す' : '正解の選択肢を選ぶ',
        options.map((option) => ({
          label: truncate(option.label, 100),
          value: String(option.idx),
          emoji: LETTERS[option.idx],
        })),
      ),
      picked
        ? row(
            button(`pl:settle:${poll.id}:${picked.idx}`, 'この選択肢で確定', { emoji: '✅', style: ButtonStyle.SUCCESS }),
          )
        : null,
    ].filter(Boolean),
  };
}

async function handlePick(ix, ctx, poll) {
  const problem = await judgeProblem(ix, ctx, poll);
  if (problem) return reply({ content: problem });
  if (poll.status === 'settled' || poll.status === 'cancelled') return reply({ content: 'この予想大会はもう終わっています。' });
  return update(await answerPayload(ctx, poll, Number(ix.values[0])));
}

async function handleSettle(ix, ctx, poll, rawOption) {
  const problem = await judgeProblem(ix, ctx, poll);
  if (problem) return reply({ content: problem });
  const answerIdx = Number(rawOption ?? ix.values[0]);
  const settings = await getSettings(ctx.db, poll.guild_id);
  const options = await optionsOf(ctx.db, poll.id);
  if (!options[answerIdx]) return reply({ content: 'その選択肢はありません。' });

  const result = await settlePoll(ctx.db, poll, answerIdx);
  if (!result.settled) return reply({ content: 'この予想大会はもう終わっています。' });

  // 押されたのは出題者だけのメッセージ。みんなの掲示板は別に結果へ書き換える
  const payload = resultPayload(poll, options, answerIdx, result, settings);
  if (poll.message_id) {
    ctx.waitUntil(
      ctx.rest
        .editMessage(poll.channel_id, poll.message_id, { ...payload, allowed_mentions: { parse: [] } })
        .catch((error) => console.error('予想大会の結果表示に失敗:', error)),
    );
  }
  return update(payload);
}

/** 結果発表。 */
export function resultPayload(poll, options, answerIdx, result, settings) {
  // いちばん見せたいのは「正解が何だったか」。title に置いて先に読ませる
  const answer = `正解 ${LETTERS[answerIdx]} ${options[answerIdx]?.label ?? '—'}`;
  const lines = [];

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
        title: `🏆 ${truncate(answer, 100)}`,
        description: lines.join('\n'),
        fields: [{ name: 'お題', value: truncate(poll.question, 1000) }],
        footer: { text: '予想大会' },
      }),
    ],
    components: [
      row(button(`pl:more:${poll.id}`, 'もう1問出す', { emoji: '🔁', style: ButtonStyle.SUCCESS })),
    ],
  };
}
