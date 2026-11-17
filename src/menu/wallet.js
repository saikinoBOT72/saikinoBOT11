import { getBalance, ledgerFor, rankOf, topBalances, totals, transfer } from '../lib/economy.js';
import { equippedTitles, titleTag } from '../lib/achievements.js';
import { coins } from '../lib/format.js';
import { reasonLabel } from '../lib/ledger-reasons.js';
import { MATCH_GAMES, statsOf } from '../lib/match-results.js';
import { modal, textInput, userSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
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

const MEDALS = ['🥇', '🥈', '🥉'];

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const [rank, sums] = await Promise.all([
    rankOf(ctx.db, ix.guildId, ix.userId),
    totals(ctx.db, ix.guildId, ix.userId),
  ]);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf1c40f,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: '💰 お財布',
          description: coins(balance, settings),
          fields: [
            { name: 'サーバー順位', value: `**${rank}** 位`, inline: true },
            { name: '累計獲得', value: sums.earned.toLocaleString('ja-JP'), inline: true },
            { name: '累計使用', value: sums.spent.toLocaleString('ja-JP'), inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('wallet', 'pay'), '送金する', { emoji: '💸', style: ButtonStyle.PRIMARY }),
        button(id('wallet', 'history'), '履歴', { emoji: '📜' }),
        button(id('wallet', 'rank'), 'ランキング', { emoji: '🏆' }),
      ),
      row(
        button(id('wallet', 'stats'), '戦績', { emoji: '📊' }),
        button(id('titles', 'open'), '称号・連続記録', { emoji: '🏅' }),
        button(id('privacy', 'open'), '自分のデータ', { emoji: '🔐' }),
      ),
      row(backButton()),
    ],
  });
}

export async function pay(ix, _args, _ctx, notice = null) {
  return show(ix, {
    embeds: [
      withNotice(embed({ color: 0xf1c40f, title: '💸 送金', description: '送りたい相手を選んでください。' }), notice),
    ],
    components: [userSelect(id('wallet', 'payto'), '送る相手を選ぶ'), row(backButton('wallet'), homeButton())],
  });
}

export async function payto(ix, _args, ctx) {
  const targetId = ix.values[0];
  if (targetId === ix.userId) return pay(ix, [], ctx, '自分自身には送金できません。');
  const target = ix.raw.data?.resolved?.users?.[targetId];
  if (target?.bot) return pay(ix, [], ctx, 'Botには送金できません。');

  return openModal(
    modal(id('wallet', 'paydo', targetId), `${target?.username ?? 'メンバー'} に送金`, [
      textInput('amount', '金額', { required: true, max: 12, placeholder: '例: 100' }),
      textInput('memo', 'メモ（任意）', { max: 100 }),
    ]),
  );
}

export async function paydo(ix, [targetId], ctx) {
  const settings = await ctx.settings(ix.guildId);
  const amount = readInt(ix, 'amount', { min: 1 });
  if (isError(amount)) return open(ix, [], ctx, amount.error);
  const memo = readText(ix, 'memo');

  const ok = await transfer(ctx.db, ix.guildId, ix.userId, targetId, amount, 'pay', memo);
  if (!ok) {
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    return open(ix, [], ctx, `残高が足りません。現在の所持金は ${coins(balance, settings)} です。`);
  }

  ctx.announce(ix.channelId, {
    content: `💸 <@${ix.userId}> → <@${targetId}> に ${coins(amount, settings)} を送金しました。${memo ? `\n> ${memo}` : ''}`,
    allowed_mentions: { users: [targetId] },
  });

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '✅ 送金しました',
        description: `<@${targetId}> に ${coins(amount, settings)} を送りました。\n残りは ${coins(balance, settings)} です。`,
      }),
    ],
    components: [row(backButton('wallet'), homeButton())],
  });
}

export async function history(ix, _args, ctx) {
  const entries = await ledgerFor(ctx.db, ix.guildId, ix.userId, 15);
  return show(ix, {
    embeds: [
      embed({
        color: 0xf1c40f,
        title: '📜 コインの履歴',
        description:
          entries.length === 0
            ? 'まだ履歴がありません。'
            : entries
                .map((entry) => {
                  const sign = entry.amount >= 0 ? '+' : '';
                  return `<t:${Math.floor(entry.created_at / 1000)}:R>　\`${sign}${entry.amount}\`　${reasonLabel(entry)}`;
                })
                .join('\n'),
      }),
    ],
    components: [row(backButton('wallet'), homeButton())],
  });
}

export async function rank(ix, _args, ctx) {
  const settings = await ctx.settings(ix.guildId);
  const rows = await topBalances(ctx.db, ix.guildId, 15);
  const titles = await equippedTitles(ctx.db, ix.guildId, rows.map((row) => row.user_id));

  return show(ix, {
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `🏆 ${settings.currency_name}ランキング`,
        description:
          rows.length === 0
            ? 'まだ誰も口座を持っていません。'
            : rows
                .map((entry, index) => {
                  const tag = titleTag(titles.get(entry.user_id));
                  return (
                    `${MEDALS[index] ?? `**${index + 1}.**`} ${tag ? `\`${tag}\` ` : ''}` +
                    `<@${entry.user_id}> — ${settings.currency_emoji} ${entry.balance.toLocaleString('ja-JP')}`
                  );
                })
                .join('\n'),
      }),
    ],
    components: [row(backButton('wallet'), homeButton())],
  });
}

/** 📊 戦績：ゲームごとの収支と、1対1の勝ち負け（相手ごと）。 */
export async function stats(ix, _args, ctx) {
  const data = await statsOf(ctx.db, ix.guildId, ix.userId);
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toLocaleString('ja-JP')}`;
  const rate = (wins, losses) => (wins + losses > 0 ? `勝率 ${Math.round((wins / (wins + losses)) * 100)}%` : '');

  const fields = [];
  if (data.games.length > 0) {
    fields.push({
      name: '🎮 ゲームごとの収支',
      value: data.games
        .slice(0, 12)
        .map((entry) => `${entry.net >= 0 ? '🟢' : '🔴'} **${entry.name}** ${signed(entry.net)}　*(${entry.plays}回)*`)
        .join('\n'),
    });
  }
  if (data.wins + data.losses > 0) {
    fields.push(
      {
        name: '⚔️ 1対1の勝ち負け',
        value:
          `**${data.wins}勝 ${data.losses}敗**　${rate(data.wins, data.losses)}\n` +
          data.byGame.map((entry) => `・${MATCH_GAMES[entry.game] ?? entry.game} ${entry.wins}勝${entry.losses}敗`).join('\n'),
        inline: true,
      },
      {
        name: '🤝 よく戦う相手',
        value: data.rivals.map((entry) => `<@${entry.rival}> ${entry.wins}勝${entry.losses}敗`).join('\n') || '—',
        inline: true,
      },
    );
  }

  return show(ix, {
    embeds: [
      embed({
        color: 0xf1c40f,
        author: { name: ix.displayName, icon_url: ix.avatar },
        title: '📊 戦績',
        description: fields.length === 0 ? 'まだ記録がありません。ゲームで遊ぶとここに積み上がります。' : undefined,
        fields,
        footer: { text: '1対1の勝ち負けは、この機能が入った版から数えています' },
      }),
    ],
    components: [row(backButton('wallet', 'お財布へ'), homeButton())],
  });
}

export const actions = { open, pay, payto, paydo, history, rank, stats };
