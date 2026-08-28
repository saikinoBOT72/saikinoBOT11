import {
  cancelExpired,
  createMatch,
  escrowFor,
  finishMatch,
  getMatch,
  markPlaying,
  recordRoll,
  setMessageId,
  setStatus,
  settle,
} from '../lib/chinchiro.js';
import { MAX_MULTIPLIER, compare, diceLine, evaluate, handLabel, rollHand } from '../lib/dice.js';
import { deposit, getSettings, withdraw } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

/** 公開メッセージのボタンは `cc:` 始まり。 */
export const namespace = 'cc';

export { cancelExpired };

/** 挑戦状をチャンネルに投稿する。 */
export async function startChallenge(ctx, { guildId, channelId, challengerId, opponentId, bet, settings }) {
  const id = crypto.randomUUID();
  await createMatch(ctx.db, { id, guildId, channelId, challengerId, opponentId, bet });

  try {
    const message = await ctx.rest.createMessage(channelId, {
      content: `<@${opponentId}>`,
      embeds: [
        embed({
          color: 0xe67e22,
          title: '🎲 チンチロ勝負！',
          description:
            `<@${challengerId}> が <@${opponentId}> に勝負を挑みました。\n` +
            `賭け金は ${coins(bet, settings)}。**役によって動く額が変わります。**`,
          fields: [
            { name: '預かる額', value: `${coins(escrowFor(bet), settings)}（最大×${MAX_MULTIPLIER}）`, inline: true },
            { name: '精算', value: '勝負が終わったら余りは返します', inline: true },
            { name: '役と倍率', value: PAYOUT_TABLE },
          ],
          footer: { text: '2分以内に応答がなければ自動でキャンセルされます' },
        }),
      ],
      components: [
        row(
          button(`cc:accept:${id}`, '受けて立つ', { style: ButtonStyle.SUCCESS }),
          button(`cc:decline:${id}`, 'やめておく', { style: ButtonStyle.SECONDARY }),
        ),
      ],
      allowed_mentions: { users: [opponentId] },
    });
    await setMessageId(ctx.db, id, message.id);
    return message;
  } catch (error) {
    console.error('チンチロの挑戦状の投稿に失敗:', error);
    await setStatus(ctx.db, id, 'cancelled');
    return null;
  }
}

const PAYOUT_TABLE = [
  '🌟 ピンゾロ（1・1・1） **×5**',
  '✨ ゾロ目 **×3**',
  '🔥 シゴロ（4・5・6） **×2**',
  '🎲 出目（大きい方が勝ち） **×1**',
  '💀 ヒフミ（1・2・3）を出したら負けて **×2払い**',
].join('\n');

export async function handleComponent(ix, ctx) {
  const [, action, id] = ix.customId.split(':');
  const match = await getMatch(ctx.db, id);

  if (!match || match.status === 'done' || match.status === 'cancelled') {
    return reply({ content: 'この勝負はすでに終了しています。' });
  }
  if (action === 'accept' || action === 'decline') return handleInvite(ix, ctx, match, action);
  if (action === 'roll') return handleRoll(ix, ctx, match);
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

  if (!(await markPlaying(ctx.db, match.id))) return reply({ content: 'この勝負はすでに始まっています。' });

  const settings = await getSettings(ctx.db, match.guild_id);

  // 動きうる最大額を両者から預かる。足りなければ元に戻して中止
  if (!(await withdraw(ctx.db, match.guild_id, match.challenger_id, match.escrow, 'chinchiro:escrow', match.id))) {
    await setStatus(ctx.db, match.id, 'cancelled');
    return update({
      content: '',
      embeds: [cancelEmbed(`<@${match.challenger_id}> の残高が足りないため中止しました（${match.escrow} 必要）。`)],
      components: [],
    });
  }
  if (!(await withdraw(ctx.db, match.guild_id, match.opponent_id, match.escrow, 'chinchiro:escrow', match.id))) {
    await deposit(ctx.db, match.guild_id, match.challenger_id, match.escrow, 'chinchiro:refund', match.id);
    await setStatus(ctx.db, match.id, 'cancelled');
    return update({
      content: '',
      embeds: [cancelEmbed(`<@${match.opponent_id}> の残高が足りないため中止しました（${match.escrow} 必要）。`)],
      components: [],
    });
  }

  return update({
    content: `<@${match.challenger_id}>`,
    embeds: [tableEmbed({ ...match, turn: 'challenger' }, settings)],
    components: [rollRow(match.id)],
  });
}

async function handleRoll(ix, ctx, match) {
  const role =
    ix.userId === match.challenger_id ? 'challenger' : ix.userId === match.opponent_id ? 'opponent' : null;
  if (!role) return reply({ content: 'この勝負の参加者ではありません。' });
  if (match.turn !== role) return reply({ content: 'いまはあなたの番ではありません。' });

  const { throws, hand } = rollHand();
  if (!(await recordRoll(ctx.db, match.id, role, throws))) {
    return reply({ content: 'すでに振っています。' });
  }

  const settings = await getSettings(ctx.db, match.guild_id);
  const updated = await getMatch(ctx.db, match.id);
  const frames = throws.map((dice, index) => ({
    after: index === 0 ? 700 : 800,
    payload: {
      content: '',
      embeds: [
        embed({
          color: 0xe67e22,
          title: '🎲 チンチロ',
          description:
            `<@${ix.userId}> が振っています…\n\n# ${diceLine(dice)}\n` +
            `${index + 1}回目：${index === throws.length - 1 ? handLabel(hand) : '役なし、振り直し！'}`,
        }),
      ],
      components: [],
    },
  }));

  // 両者が振り終えていれば決着、まだなら手番を渡す
  if (updated.challenger_dice && updated.opponent_dice) {
    frames.push({ after: 900, payload: await resolveMatch(ctx, updated, settings) });
  } else {
    frames.push({
      after: 900,
      payload: {
        content: `<@${match.opponent_id}>`,
        embeds: [tableEmbed(updated, settings)],
        components: [rollRow(match.id)],
      },
    });
  }
  ctx.animate(ix, frames);

  return update({
    content: '',
    embeds: [
      embed({
        color: 0xe67e22,
        title: '🎲 チンチロ',
        description: `<@${ix.userId}> がサイコロを振りました…\n\n# 🎲 🎲 🎲`,
      }),
    ],
    components: [],
  });
}

/**
 * 両者の出目から勝敗を決めて精算し、最後のコマを作る。
 * compare() と settle() は同じ 'challenger'|'opponent' で話す。テストから直接呼べるように公開している。
 */
export async function resolveMatch(ctx, match, settings) {
  const challengerHand = evaluate(lastThrow(match.challenger_dice));
  const opponentHand = evaluate(lastThrow(match.opponent_dice));
  const result = compare(challengerHand, opponentHand);

  if (!(await finishMatch(ctx.db, match.id))) {
    return { content: '', embeds: [cancelEmbed('この勝負はすでに精算済みです。')], components: [] };
  }
  const { prize } = await settle(ctx.db, match, result.winner, result.multiplier);

  const lines = [
    `<@${match.challenger_id}>　${diceLine(challengerHand.dice)}　${handLabel(challengerHand)}`,
    `<@${match.opponent_id}>　${diceLine(opponentHand.dice)}　${handLabel(opponentHand)}`,
    '',
  ];
  if (result.winner === 'draw') {
    lines.push(`🤝 **引き分け**（${result.reason}）。預かった額はそのまま返しました。`);
  } else {
    const winnerId = result.winner === 'challenger' ? match.challenger_id : match.opponent_id;
    const loserId = result.winner === 'challenger' ? match.opponent_id : match.challenger_id;
    lines.push(
      `🏆 **<@${winnerId}> の勝ち！**（${result.reason}・×${result.multiplier}）`,
      `<@${loserId}> から ${coins(prize, settings)} を受け取りました。`,
    );
  }

  return {
    content: '',
    embeds: [embed({ color: 0x2ecc71, title: '🎲 チンチロ 結果', description: lines.join('\n') })],
    components: [],
  };
}

function lastThrow(json) {
  const throws = JSON.parse(json);
  return throws[throws.length - 1];
}

function tableEmbed(match, settings) {
  const waiting = match.turn === 'challenger' ? match.challenger_id : match.opponent_id;
  const done = [];
  if (match.challenger_dice) {
    const hand = evaluate(lastThrow(match.challenger_dice));
    done.push(`<@${match.challenger_id}>　${diceLine(hand.dice)}　${handLabel(hand)}`);
  }
  return embed({
    color: 0xe67e22,
    title: '🎲 チンチロ',
    description:
      (done.length > 0 ? `${done.join('\n')}\n\n` : '') +
      `<@${waiting}> の番です。サイコロを振ってください。\n` +
      `賭け金 ${coins(match.bet, settings)}（預かり ${match.escrow}）`,
    fields: [{ name: '役と倍率', value: PAYOUT_TABLE }],
    footer: { text: '役が出るまで最大3回振ります' },
  });
}

function rollRow(id) {
  return row(button(`cc:roll:${id}`, 'サイコロを振る', { emoji: '🎲', style: ButtonStyle.PRIMARY }));
}

export function cancelEmbed(text) {
  return embed({ color: 0xe74c3c, title: 'チンチロ中止', description: text });
}
