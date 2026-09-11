/**
 * 1対1の対戦ゲームの、チャンネルに出る公開メッセージ。
 *
 * 挑戦状 → 承諾 → 対戦 → 精算 までの共通の流れをここが持ち、
 * ルールごとの中身（盤面の描き方・ボタンを押されたときの処理）は
 * GAMES に登録した各ゲームの実装に任せる。
 */
import {
  cancelExpired,
  createDuel,
  finishDuel,
  getDuel,
  refundDuel,
  roleOf,
  setMessageId,
  setStatus,
  startDuel,
  stateOf,
  userIdOf,
} from '../lib/duel.js';
import { deposit, getSettings, withdraw } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';
import { handleRematch } from './rematch.js';
import * as roulette from './duel-roulette.js';
import * as charge from './duel-charge.js';
import * as mines from './duel-mines.js';
import * as doors from './duel-doors.js';
import { EMOJI as em } from '../lib/emoji.js';

/** 公開メッセージのボタンは `d:` 始まり。 */
export const namespace = 'd';

export { cancelExpired };

/** ルールごとの実装。キーは duels.game に入る。 */
export const GAMES = {
  rr: roulette,
  cs: charge,
  mine: mines,
  doors,
};

export function findGame(key) {
  return GAMES[key] ?? null;
}

/**
 * 挑戦状をチャンネルに投稿する。
 * @returns {Promise<object|null>} 投稿したメッセージ
 */
export async function startChallenge(ctx, { game, guildId, channelId, challengerId, opponentId, bet, settings }) {
  const rules = findGame(game);
  if (!rules) return null;

  const id = crypto.randomUUID();
  const escrow = rules.escrowFor ? rules.escrowFor(bet) : bet;
  await createDuel(ctx.db, {
    id,
    guildId,
    channelId,
    game,
    challengerId,
    opponentId,
    bet,
    escrow,
    state: {},
  });

  try {
    const message = await ctx.rest.createMessage(channelId, {
      content: `<@${opponentId}>`,
      embeds: [
        embed({
          color: rules.color,
          title: `${em[rules.emojiSlot]} ${rules.title}`,
          description:
            `<@${challengerId}> が <@${opponentId}> に勝負を挑みました。\n` +
            `賭け金は ${coins(bet, settings)}（**勝った方が総取り**）`,
          fields: rules.inviteFields ? rules.inviteFields({ bet, escrow, settings }) : [],
          footer: { text: '2分以内に応答がなければ自動でキャンセルされます' },
        }),
      ],
      components: [
        row(
          button(`d:accept:${id}`, '受けて立つ', { style: ButtonStyle.SUCCESS }),
          button(`d:decline:${id}`, 'やめておく', { style: ButtonStyle.SECONDARY }),
        ),
      ],
      allowed_mentions: { users: [opponentId] },
    });
    await setMessageId(ctx.db, id, message.id);
    return message;
  } catch (error) {
    console.error(`${game} の挑戦状の投稿に失敗:`, error);
    await setStatus(ctx.db, id, 'cancelled');
    return null;
  }
}

export async function handleComponent(ix, ctx) {
  const [, action, id, ...args] = ix.customId.split(':');
  const duel = await getDuel(ctx.db, id);

  // 再戦は終わった勝負のメッセージから押されるので、終了チェックより先に見る
  if (action === 'again') {
    if (!duel) return reply({ content: 'この勝負の記録が見つかりませんでした。' });
    return handleRematch(ix, ctx, {
      challengerId: duel.challenger_id,
      opponentId: duel.opponent_id,
      bet: duel.bet,
      start: (next) =>
        startChallenge(ctx, { game: duel.game, guildId: duel.guild_id, channelId: duel.channel_id, ...next }),
    });
  }

  if (!duel || duel.status === 'done' || duel.status === 'cancelled') {
    return reply({ content: 'この勝負はすでに終了しています。' });
  }
  const rules = findGame(duel.game);
  if (!rules) return reply({ content: '不明なゲームです。' });

  if (action === 'accept' || action === 'decline') return handleInvite(ix, ctx, duel, rules, action);
  if (duel.status !== 'playing') return reply({ content: 'この勝負はまだ始まっていません。' });

  const role = roleOf(duel, ix.userId);
  if (!role) return reply({ content: 'この勝負の参加者ではありません。' });

  return rules.handle(ix, ctx, { duel, rules, role, state: stateOf(duel), action, args });
}

async function handleInvite(ix, ctx, duel, rules, action) {
  if (ix.userId !== duel.opponent_id) {
    return reply({ content: 'この勝負に呼ばれているのはあなたではありません。' });
  }

  if (action === 'decline') {
    await setStatus(ctx.db, duel.id, 'cancelled');
    return update({
      content: '',
      embeds: [cancelEmbed(rules, `<@${duel.opponent_id}> は勝負を断りました。`)],
      components: [],
    });
  }

  // 賭け金を先に預かる。足りなければ元に戻して中止
  const first = await startDuel(ctx.db, duel.id, { first: rules.firstTurn ? rules.firstTurn() : null });
  if (!first) return reply({ content: 'この勝負はすでに始まっています。' });

  for (const role of ['challenger', 'opponent']) {
    const userId = userIdOf(duel, role);
    if (await withdraw(ctx.db, duel.guild_id, userId, duel.escrow, `${duel.game}:bet`, duel.id)) continue;

    // 片方だけ引き落とせていたら戻す
    if (role === 'opponent') {
      await deposit(ctx.db, duel.guild_id, duel.challenger_id, duel.escrow, `${duel.game}:refund`, duel.id);
    }
    await setStatus(ctx.db, duel.id, 'cancelled');
    return update({
      content: '',
      embeds: [cancelEmbed(rules, `<@${userId}> の残高が足りないため中止しました（${duel.escrow} 必要）。`)],
      components: [],
    });
  }

  const started = await getDuel(ctx.db, duel.id);
  const settings = await getSettings(ctx.db, duel.guild_id);
  return update(await rules.start(ctx, { duel: started, state: stateOf(started), settings }));
}

/** 勝負が流れたときの表示。 */
export function cancelEmbed(rules, text) {
  return embed({ color: 0xe74c3c, title: `${rules?.title ?? '勝負'} 中止`, description: text });
}

/** 各ゲームから使う、決着表示の共通部分。 */
export function resultEmbed({ rules, title, description, fields = [] }) {
  return embed({
    color: 0xf1c40f,
    title: `${em[rules.emojiSlot]} ${title ?? `${rules.title} 結果`}`,
    description,
    fields,
  });
}

export { finishDuel, refundDuel };
