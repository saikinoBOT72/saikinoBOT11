/**
 * 管理メニュー：経済の様子・設定の書き出しと読み込み・はじめの準備リスト。
 */
import { economyOverview, sparkline } from '../lib/economy-stats.js';
import { exportSettings, parseBackup } from '../lib/backup.js';
import { upsertActivity } from '../lib/activities.js';
import { updateSettings } from '../lib/economy.js';
import { GAME_NAMES } from '../lib/ledger-reasons.js';
import { coins } from '../lib/format.js';
import { modal, textInput } from '../discord/builders.js';
import { ButtonStyle, TextInputStyle } from '../discord/constants.js';
import { COLORS, backButton, button, embed, homeButton, id, openModal, row, show, withNotice } from './common.js';
import { open as openHome } from './home.js';

function denied(ix, ctx) {
  return openHome(ix, [], ctx, 'この操作には「サーバー管理」権限が必要です。');
}

/**
 * はじめの準備。終わっていないものだけ目立たせる。
 * @returns {Promise<Array<{done: boolean, text: string}>>}
 */
export async function setupChecklist(db, guildId, settings) {
  const count = async (sql) => (await db.get(sql, guildId))?.n ?? 0;
  const [activities, rewards, achievements, announcements] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM activities WHERE guild_id = ?1'),
    count('SELECT COUNT(*) AS n FROM streak_rewards WHERE guild_id = ?1'),
    count('SELECT COUNT(*) AS n FROM achievements WHERE guild_id = ?1'),
    count('SELECT COUNT(*) AS n FROM announcements WHERE guild_id = ?1'),
  ]);
  return [
    { done: activities > 0, text: '報告のアクションを登録する（📋 アクション）' },
    { done: rewards > 0, text: '連日ボーナスを決める（🔥 連日ボーナス）' },
    { done: achievements > 0, text: '称号を作る（🏅 称号）' },
    { done: Boolean(settings.game_channel_id), text: '卓や挑戦状を出す場所を決める（🛠️ Botの設定）' },
    { done: Boolean(settings.log_channel_id), text: 'エラーや新しい版のお知らせ先を決める（🧰 管理用チャンネル）' },
    { done: announcements > 0, text: 'ランキングの定期発表を決める（📢 定期発表）' },
  ];
}

/* ------------------------------------------------------------------ 経済の様子 */

export async function eco(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const data = await economyOverview(ctx.db, ix.guildId, ctx.calendar);
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toLocaleString('ja-JP')}`;

  const hints = [];
  if (data.topShare >= 0.6) hints.push('上位1割の人が全体の6割以上を持っています。報告の報酬を上げるか、賭け金の上限を下げると偏りが和らぎます。');
  if (data.average > 0 && data.mintedWeek > data.total * 0.5) hints.push('この7日で、出回っている量の半分以上が新しく生まれています。報酬が多すぎるかもしれません。');

  return show(ix, {
    embeds: [
      embed({
        color: COLORS.admin,
        title: '📈 経済の様子',
        description: '出回っているコインの量と、この7日の動きです。設定を見直すときの目安にしてください。',
        fields: [
          { name: '出回っている合計', value: coins(data.total, settings), inline: true },
          { name: '口座の数', value: `${data.accounts} 人`, inline: true },
          { name: '1人あたり', value: data.average.toLocaleString('ja-JP'), inline: true },
          { name: '上位1割の持ち分', value: `${Math.round(data.topShare * 100)}%`, inline: true },
          { name: 'いちばん多い人', value: data.richest.toLocaleString('ja-JP'), inline: true },
          { name: '7日で生まれた量', value: data.mintedWeek.toLocaleString('ja-JP'), inline: true },
          { name: '日ごとに生まれた量（7日）', value: `\`${sparkline(data.perDay)}\`　${data.perDay.map((n) => n.toLocaleString('ja-JP')).join(' / ')}` },
          {
            name: '🎮 ゲームでの出入り（7日・マイナスは場から消えたぶん）',
            value:
              data.games.map((game) => `**${GAME_NAMES[game.game] ?? game.game}** ${signed(game.net)}　*(${game.n}件)*`).join('\n') ||
              'この7日はゲームの動きがありません',
          },
          ...(hints.length > 0 ? [{ name: '💡 気づいたこと', value: hints.join('\n') }] : []),
        ],
        footer: { text: '個人ごとの数字はここには出しません' },
      }),
    ],
    components: [row(backButton('admin', '管理メニューへ'), homeButton())],
  });
}

/* ------------------------------------------------------------------ 設定の書き出し・読み込み */

export async function backup(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const text = await exportSettings(ctx.db, ix.guildId, settings);
  const tooLong = text.length > 3600;

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: COLORS.admin,
          title: '💾 設定の書き出し・読み込み',
          description:
            (tooLong
              ? '設定が長すぎて1画面に入りません。称号・連日ボーナスはそれぞれの画面の **📤 書き出す** を使ってください。'
              : `\`\`\`json\n${text}\n\`\`\``) +
            '\n\n**入っているもの**：通貨・賭け金・1日の区切り・ゲームのオンオフなどの設定と、報告のアクション\n' +
            '**入っていないもの**：チャンネルの指定（サーバーごとに違うため）、メンバーの残高や記録、称号・連日ボーナス\n\n' +
            'このまま **📥 読み込む** に貼ると、同じ設定にできます（書き出しに無いアクションは消しません）。',
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('admin', 'backupin'), '読み込む', { emoji: '📥', style: ButtonStyle.PRIMARY }),
        backButton('admin', '管理メニューへ'),
        homeButton(),
      ),
    ],
  });
}

export async function backupin(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return openModal(
    modal(id('admin', 'backupsave'), '設定を読み込む', [
      textInput('backup', '書き出した文字をそのまま貼る', { style: TextInputStyle.PARAGRAPH, required: true, max: 4000 }),
    ]),
  );
}

export async function backupsave(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const { settings, activities, errors } = parseBackup(ix.field('backup'));
  if (Object.keys(settings).length === 0 && activities.length === 0) {
    return backup(ix, [], ctx, errors[0] ?? '読み込めるものがありませんでした。');
  }

  if (Object.keys(settings).length > 0) {
    await updateSettings(ctx.db, ix.guildId, settings);
    ctx.forgetSettings(ix.guildId);
  }
  for (const activity of activities) await upsertActivity(ctx.db, ix.guildId, activity);

  const skipped = errors.length > 0 ? `（読めなかったもの ${errors.length} 件：${errors.slice(0, 3).join(' / ')}）` : '';
  return backup(ix, [], ctx, {
    kind: errors.length > 0 ? 'warn' : 'ok',
    text: `設定 ${Object.keys(settings).length} 項目とアクション ${activities.length} 件を読み込みました${skipped}`,
  });
}

export const toolActions = { eco, backup, backupin, backupsave };
