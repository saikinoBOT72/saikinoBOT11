/**
 * 🎋 おみくじ。1日1回だけ引ける。
 *
 * コインは動かさない。読んで楽しむだけのもの。
 * 引き直しはできないので、同じ日に開き直すと同じ紙が出る。
 *
 * 【縦に並べている理由】
 * 1文が30〜40字あるため、embed の3列（inline）に入れると折り返しだらけになる。
 * おみくじの紙らしく縦一列に並べ、短いラッキー3種だけ3列にしている。
 */
import { OMIKUJI_ITEMS, RANK_BY_NAME, drawToday, rankHistory, readOmikuji, todaysDraw } from '../lib/omikuji.js';
import { describeDayStart } from '../lib/calendar.js';
import { ButtonStyle } from '../discord/constants.js';
import { backButton, button, embed, homeButton, id, row, show, withNotice } from './common.js';

/** 総合運ごとの帯の色。凶に近づくほど沈んだ色にする。 */
const RANK_COLORS = {
  大大大吉: 0xffd700,
  大大吉: 0xf1c40f,
  大吉: 0xe67e22,
  中吉: 0x2ecc71,
  小吉: 0x27ae60,
  吉: 0x16a085,
  末吉: 0x95a5a6,
  平: 0x7f8c8d,
  吉凶未分末大吉: 0x8e44ad,
  凶: 0x5d6d7e,
  大凶: 0x34495e,
};

export async function open(ix, _args, ctx, notice = null) {
  const existing = await todaysDraw(ctx.db, ix.guildId, ix.userId, ctx.calendar);
  if (!existing) return waitingScreen(ix, ctx, notice);
  return resultScreen(ix, ctx, existing, notice);
}

/** まだ引いていない日の画面。 */
function waitingScreen(ix, ctx, notice) {
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xc0392b,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: '🎋 おみくじ',
          description:
            '今日の運勢を占います。\n\n' +
            '**引けるのは1日1回だけ**。引き直しはできません。\n' +
            'コインは増えも減りもしません。ただ読んで楽しむものです。',
          footer: { text: [describeDayStart(ctx.calendar), '結果は明日まで残ります'].filter(Boolean).join(' ／ ') },
        }),
        notice,
      ),
    ],
    components: [
      row(button(id('omi', 'draw'), 'おみくじを引く', { emoji: '🎋', style: ButtonStyle.SUCCESS })),
      row(backButton('games'), homeButton()),
    ],
  });
}

/** 引いたあとの画面。おみくじの紙に見えるように縦に並べる。 */
async function resultScreen(ix, ctx, draw, notice) {
  const paper = readOmikuji(draw);
  const history = await rankHistory(ctx.db, ix.guildId, ix.userId);

  // 吉凶の印は出さない。文そのものを読ませたいので、項目名と本文だけにする
  const lines = paper.lines.map((line) => `**${line.item}**　${line.text}`);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: RANK_COLORS[paper.rank.name] ?? 0x7f8c8d,
          author: { name: ix.displayName, icon_url: ix.avatar },
          title: `${paper.rank.emoji}　${paper.rank.name}　${paper.rank.emoji}`,
          description: lines.join('\n\n'),
          fields: [
            { name: 'ラッキーナンバー', value: `\`${paper.number}\``, inline: true },
            { name: 'ラッキーアイテム', value: paper.item, inline: true },
            { name: 'ラッキーカラー', value: paper.color, inline: true },
          ],
          footer: {
            text: [
              `これまで ${history.total} 回引きました`,
              describeDayStart(ctx.calendar),
            ]
              .filter(Boolean)
              .join(' ／ '),
          },
        }),
        notice,
      ),
    ],
    components: [row(button(id('omi', 'rec'), 'これまでの運勢', { emoji: '📜' }), backButton('games'), homeButton())],
  });
}

export async function draw(ix, _args, ctx) {
  const { draw: result, fresh } = await drawToday(ctx.db, ix.guildId, ix.userId, ctx.calendar);
  if (!result) return open(ix, [], ctx, 'おみくじを引けませんでした。もう一度お試しください。');

  // めったに出ない運勢だけ、みんなに見えるように流す
  const rank = RANK_BY_NAME.get(result.rank);
  if (fresh && rank?.rare) {
    ctx.announce(ix.channelId, {
      embeds: [
        embed({
          color: RANK_COLORS[rank.name] ?? 0xf1c40f,
          title: `${rank.emoji} ${rank.name} ${rank.emoji}`,
          description: `<@${ix.userId}> がおみくじで **${rank.name}** を引きました。\nめったに出ないものです。`,
        }),
      ],
    });
  }
  return open(ix, [], ctx, fresh ? null : '今日はもう引いています。');
}

/** これまでに引いた総合運の内訳。 */
export async function rec(ix, _args, ctx) {
  const history = await rankHistory(ctx.db, ix.guildId, ix.userId);

  const lines = [...RANK_BY_NAME.values()].map((rank) => {
    const count = history.counts.get(rank.name) ?? 0;
    return `${rank.emoji} **${rank.name}**　${count > 0 ? `${count} 回` : '—'}`;
  });

  return show(ix, {
    embeds: [
      embed({
        color: 0xc0392b,
        author: { name: ix.displayName, icon_url: ix.avatar },
        title: '📜 これまでの運勢',
        description: history.total === 0 ? 'まだ引いたことがありません。' : lines.join('\n'),
        footer: { text: `合計 ${history.total} 回` },
      }),
    ],
    components: [row(button(id('omi', 'open'), 'おみくじへ', { emoji: '🎋' }), homeButton())],
  });
}

export const actions = { open, draw, rec };
