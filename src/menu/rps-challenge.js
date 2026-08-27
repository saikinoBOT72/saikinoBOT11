import {
  HANDS,
  MAX_DRAWS,
  createMatch,
  getMatch,
  judge,
  markPlaying,
  nextRound,
  refund,
  setHand,
  setMessageId,
  setStatus,
} from '../lib/rps.js';
import { deposit, getSettings, withdraw } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `rps:` 始まり（メニューの `m:` とは別系統）。 */
export const namespace = 'rps';

/**
 * 挑戦状をチャンネルに投稿する。
 * @returns {Promise<object|null>} 投稿したメッセージ
 */
export async function startChallenge(ctx, { guildId, channelId, challengerId, opponentId, bet, settings }) {
  const id = crypto.randomUUID();
  await createMatch(ctx.db, { id, guildId, channelId, challengerId, opponentId, bet });

  try {
    const message = await ctx.rest.createMessage(channelId, {
      content: `<@${opponentId}>`,
      embeds: [
        embed({
          color: 0x5865f2,
          title: '✊✌️🖐️ じゃんけん勝負！',
          description:
            `<@${challengerId}> が <@${opponentId}> に勝負を挑みました。\n` +
            (bet > 0 ? `賭け金は ${coins(bet, settings)}（勝者が総取り）` : '賭けなしの真剣勝負'),
          footer: { text: '2分以内に応答がなければ自動でキャンセルされます' },
        }),
      ],
      components: [
        row(
          button(`rps:accept:${id}`, '受けて立つ', { style: ButtonStyle.SUCCESS }),
          button(`rps:decline:${id}`, 'やめておく', { style: ButtonStyle.SECONDARY }),
        ),
      ],
      allowed_mentions: { users: [opponentId] },
    });
    await setMessageId(ctx.db, id, message.id);
    return message;
  } catch (error) {
    console.error('挑戦状の投稿に失敗:', error);
    await setStatus(ctx.db, id, 'cancelled');
    return null;
  }
}

export async function handleComponent(ix, ctx) {
  const [, action, id, hand] = ix.customId.split(':');
  const match = await getMatch(ctx.db, id);

  if (!match || match.status === 'done' || match.status === 'cancelled') {
    return reply({ content: 'この勝負はすでに終了しています。' });
  }
  if (action === 'accept' || action === 'decline') return handleInvite(ix, ctx, match, action);
  if (action === 'hand') return handleHand(ix, ctx, match, hand);
  return reply({ content: '不明な操作です。' });
}

async function handleInvite(ix, ctx, match, action) {
  if (ix.userId !== match.opponent_id) {
    return reply({ content: 'この勝負に呼ばれているのはあなたではありません。' });
  }

  if (action === 'decline') {
    await setStatus(ctx.db, match.id, 'cancelled');
    return update({
      content: '',
      embeds: [cancelEmbed(`<@${match.opponent_id}> は勝負を断りました。`)],
      components: [],
    });
  }

  if (!(await markPlaying(ctx.db, match.id))) {
    return reply({ content: 'この勝負はすでに始まっています。' });
  }

  const settings = await getSettings(ctx.db, match.guild_id);

  // 賭け金を先に預かる。片方でも足りなければ元に戻して中止する
  if (match.bet > 0) {
    if (!(await withdraw(ctx.db, match.guild_id, match.challenger_id, match.bet, 'rps:bet', match.id))) {
      await setStatus(ctx.db, match.id, 'cancelled');
      return update({
        content: '',
        embeds: [cancelEmbed(`<@${match.challenger_id}> の残高が足りないため中止しました。`)],
        components: [],
      });
    }
    if (!(await withdraw(ctx.db, match.guild_id, match.opponent_id, match.bet, 'rps:bet', match.id))) {
      await deposit(ctx.db, match.guild_id, match.challenger_id, match.bet, 'rps:refund', match.id);
      await setStatus(ctx.db, match.id, 'cancelled');
      return update({
        content: '',
        embeds: [cancelEmbed(`<@${match.opponent_id}> の残高が足りないため中止しました。`)],
        components: [],
      });
    }
  }

  return update({
    content: `<@${match.challenger_id}> <@${match.opponent_id}>`,
    embeds: [playEmbed(match, settings, 1)],
    components: [handRow(match.id)],
  });
}

async function handleHand(ix, ctx, match, hand) {
  const role =
    ix.userId === match.challenger_id ? 'challenger' : ix.userId === match.opponent_id ? 'opponent' : null;
  if (!role) return reply({ content: 'この勝負の参加者ではありません。' });
  if (!HANDS[hand]) return reply({ content: '不明な手です。' });

  if (!(await setHand(ctx.db, match.id, role, hand))) {
    return reply({ content: 'すでに手を出しています。相手を待ちましょう。' });
  }

  const updated = await getMatch(ctx.db, match.id);
  if (!updated.challenger_hand || !updated.opponent_hand) {
    return reply({ content: `${HANDS[hand].emoji} ${HANDS[hand].label} を出しました。相手を待っています。` });
  }
  return resolve(ctx, updated);
}

/** 両者の手が出そろったので勝敗を決める。 */
async function resolve(ctx, match) {
  const settings = await getSettings(ctx.db, match.guild_id);
  const result = judge(match.challenger_hand, match.opponent_hand);
  const handsLine =
    `<@${match.challenger_id}> ${HANDS[match.challenger_hand].emoji} ` +
    `vs ${HANDS[match.opponent_hand].emoji} <@${match.opponent_id}>`;

  if (result === 'draw') {
    if (match.round >= MAX_DRAWS) {
      await setStatus(ctx.db, match.id, 'done');
      await refund(ctx.db, match);
      return update({
        content: '',
        embeds: [
          embed({
            color: 0x95a5a6,
            title: '🤝 引き分け',
            description: `${handsLine}\n\nあいこが ${MAX_DRAWS} 回続いたので引き分け。賭け金は返しました。`,
          }),
        ],
        components: [],
      });
    }
    const next = await nextRound(ctx.db, match.id);
    return update({
      content: `<@${match.challenger_id}> <@${match.opponent_id}>`,
      embeds: [
        {
          ...playEmbed(next, settings, next.round),
          description: `${handsLine}\n\n**あいこ！** もう一度手を選んでください。`,
        },
      ],
      components: [handRow(match.id)],
    });
  }

  await setStatus(ctx.db, match.id, 'done');
  const winnerId = result === 'challenger' ? match.challenger_id : match.opponent_id;
  const loserId = result === 'challenger' ? match.opponent_id : match.challenger_id;
  if (match.bet > 0) await deposit(ctx.db, match.guild_id, winnerId, match.bet * 2, 'rps:win', match.id);

  return update({
    content: '',
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '🏆 じゃんけん結果',
        description:
          `${handsLine}\n\n**<@${winnerId}> の勝ち！**` +
          (match.bet > 0
            ? `\n${coins(match.bet * 2, settings)} を獲得（<@${loserId}> は ${match.bet} を失いました）`
            : ''),
      }),
    ],
    components: [],
  });
}

function playEmbed(match, settings, round) {
  return embed({
    color: 0x5865f2,
    title: '✊✌️🖐️ じゃんけん',
    description:
      `<@${match.challenger_id}> vs <@${match.opponent_id}>\n` +
      (match.bet > 0 ? `賭け金 ${coins(match.bet, settings)}（勝者が総取り）\n` : '') +
      '\n二人ともボタンで手を選んでください。選んだ手は相手には見えません。',
    footer: { text: round > 1 ? `第${round}ラウンド` : '3分以内に選ばないと引き分け返金になります' },
  });
}

function handRow(id) {
  return row(
    ...Object.entries(HANDS).map(([key, meta]) =>
      button(`rps:hand:${id}:${key}`, meta.label, { emoji: meta.emoji, style: ButtonStyle.PRIMARY }),
    ),
  );
}

export function cancelEmbed(text) {
  return embed({ color: 0xe74c3c, title: 'じゃんけん中止', description: text });
}
