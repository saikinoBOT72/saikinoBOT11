import { getBalance, rankOf } from '../lib/economy.js';
import { allStreaks } from '../lib/streak.js';
import { evaluate } from '../lib/achievements.js';
import { listActivities } from '../lib/activities.js';
import { countItems, pendingDeliveries } from '../lib/shop.js';
import { coins, truncate } from '../lib/format.js';
import { CATEGORIES, disabledSet, enabledGames, gamesIn } from '../lib/game-catalog.js';
import { dateKey, describeDayStart, startOfDay } from '../lib/calendar.js';
import { ButtonStyle } from '../discord/constants.js';
import { button, embed, homeButton, id, plainEmbed, row, show, withNotice } from './common.js';

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  // 口座がまだ無ければ、はじめて開いた人。最初の一度だけ案内を添える
  const firstTime = !(await ctx.db.get('SELECT 1 AS ok FROM balances WHERE guild_id = ?1 AND user_id = ?2', ix.guildId, ix.userId));
  // ゲームの勝ちやショップの売れ行きなど、報告以外で称号の条件を満たしていたら、ここで拾う
  if (!firstTime) {
    const unlocked = await evaluate(ctx.db, { guildId: ix.guildId, userId: ix.userId, calendar: ctx.calendar });
    if (unlocked.length > 0 && !notice) {
      notice = { kind: 'ok', text: `🏅 新しい称号を獲得しました：${unlocked.map((a) => `${a.emoji ?? ''}${a.name}`).join('、')}` };
    }
  }
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const [rank, activities, items, streaks] = await Promise.all([
    rankOf(ctx.db, ix.guildId, ix.userId),
    listActivities(ctx.db, ix.guildId),
    countItems(ctx.db, ix.guildId),
    allStreaks(ctx.db, ix.guildId, ix.userId, ctx.calendar),
  ]);
  const todo = firstTime ? [] : await todoList(ix, ctx, settings, activities, streaks);

  const main = embed({
    color: 0x5865f2,
    author: { name: ix.displayName, icon_url: ix.avatar },
    title: '🏠 メニュー',
    description: `所持金 ${coins(balance, settings)}　（${rank} 位）`,
    fields: [
      { name: '連続記録', value: topStreak(streaks), inline: true },
      { name: '報告できること', value: `${activities.length} 種類`, inline: true },
      { name: '出品中のアイテム', value: `${items} 個`, inline: true },
      firstTime || activities.length === 0
        ? null
        : { name: '📝 今日やること', value: todo.length > 0 ? todo.join('\n') : '今日やることは全部済んでいます 🎉' },
    ],
    footer: { text: 'ボタンで操作できます。このメニューはあなたにだけ見えています' },
  });

  const welcome = firstTime
    ? embed({
        color: 0x2ecc71,
        title: `👋 ようこそ！ ${coins(balance, settings)} を受け取りました`,
        description: [
          '**はじめにやること**',
          '1️⃣ **💪 報告してかせぐ** … 筋トレや勉強など、やったことを選ぶだけでコインがもらえます',
          '2️⃣ **🎮 あそぶ** … コインでゲーム。ひとりでも、みんなとでも',
          '3️⃣ **🛍️ ショップ** … みんなの出品を買ったり、自分で出品したり',
          '',
          `${settings.currency_name}は遊びのための数字で、現金などとは交換できません。くわしくは下の **📖 使い方** から。`,
        ].join('\n'),
      })
    : null;

  return show(ix, {
    embeds: [welcome, withNotice(main, notice)].filter(Boolean),
    components: [
      row(
        button(id('report', 'open'), '報告してかせぐ', { emoji: '💪', style: ButtonStyle.SUCCESS }),
        button(id('games', 'open'), 'あそぶ', { emoji: '🎮', style: ButtonStyle.PRIMARY }),
        button(id('shop', 'open'), 'ショップ', { emoji: '🛍️', style: ButtonStyle.PRIMARY }),
      ),
      row(
        button(id('wallet', 'open'), 'お財布', { emoji: '💰' }),
        button(id('home', 'open'), '更新', { emoji: '🔄' }),
        firstTime ? button(id('home', 'help'), '使い方', { emoji: '📖' }) : null,
        ix.isAdmin ? button(id('admin', 'open'), '管理', { emoji: '⚙️', style: ButtonStyle.DANGER }) : null,
      ),
    ],
  });
}

/**
 * 「今日やること」。開いた瞬間に、次に押すところが分かるように。
 * ・今日まだ報告していないアクション（途切れそうな連続記録は先頭に）
 * ・まだ引いていないおみくじ
 * ・自分宛ての挑戦状、出品者としての受け渡し待ち
 */
async function todoList(ix, ctx, settings, activities, streaks) {
  const since = startOfDay(ctx.calendar);
  const [doneRows, challenges, deliveries, omikuji] = await Promise.all([
    ctx.db.all(
      'SELECT DISTINCT activity FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2 AND created_at >= ?3',
      ix.guildId,
      ix.userId,
      since,
    ),
    ctx.db.get(
      `SELECT (SELECT COUNT(*) FROM rps_matches WHERE guild_id = ?1 AND opponent_id = ?2 AND status = 'pending')
            + (SELECT COUNT(*) FROM chinchiro_matches WHERE guild_id = ?1 AND opponent_id = ?2 AND status = 'pending')
            + (SELECT COUNT(*) FROM duels WHERE guild_id = ?1 AND opponent_id = ?2 AND status = 'pending') AS n`,
      ix.guildId,
      ix.userId,
    ),
    pendingDeliveries(ctx.db, ix.guildId, ix.userId),
    disabledSet(settings).has('omi')
      ? true
      : ctx.db.get(
          'SELECT 1 AS found FROM omikuji_draws WHERE guild_id = ?1 AND user_id = ?2 AND draw_date = ?3',
          ix.guildId,
          ix.userId,
          dateKey(ctx.calendar),
        ),
  ]);

  const done = new Set(doneRows.map((row) => row.activity));
  const lines = [];
  // 途切れそうな連続記録（昨日まで続いていて、今日まだ）
  const atRisk = streaks.filter((streak) => streak.alive && !streak.doneToday && streak.current >= 2 && !done.has(streak.activity));
  for (const streak of atRisk.slice(0, 2)) {
    lines.push(`🔥 **${truncate(streak.activity, 20)}** ${streak.current}日連続 — 今日報告すると続きます`);
  }
  const left = activities.filter((activity) => !done.has(activity.name) && !atRisk.some((streak) => streak.activity === activity.name));
  if (left.length > 0) {
    const names = left.slice(0, 3).map((activity) => `${activity.emoji ?? ''}${truncate(activity.name, 12)}`).join('・');
    lines.push(`💪 まだの報告：${names}${left.length > 3 ? ` ほか${left.length - 3}件` : ''}`);
  }
  if (!omikuji) lines.push('🎋 今日のおみくじがまだです');
  if (challenges?.n > 0) lines.push(`⚔️ あなた宛ての挑戦状が **${challenges.n}** 件あります（チャンネルで受けられます）`);
  if (deliveries.length > 0) lines.push(`📬 出品の受け渡し待ちが **${deliveries.length}** 件（🛍️ ショップ → 📦 自分の出品）`);
  return lines;
}

/** いちばん続いているアクションを一行で。 */
function topStreak(streaks) {
  const best = streaks.find((streak) => streak.current > 0);
  return best ? `🔥 ${best.activity} **${best.current}** 日` : '—';
}

export async function help(ix, _args, ctx) {
  const settings = await ctx.settings(ix.guildId);
  const currency = `${settings.currency_emoji}${settings.currency_name}`;

  return show(ix, {
    embeds: [
      embed({
        color: 0x5865f2,
        title: `${currency} の遊び方`,
        description: 'すべてこのメニューのボタンで操作できます。`/menu` でいつでも開けます。',
        fields: [
          {
            name: '💪 報告してかせぐ',
            value:
              '筋トレなどのアクションを選ぶだけで報酬がもらえます。アクションごとに「何時間おき」「1日何回まで」の制限があり、管理者が自由に決められます。押し間違えたら **5分以内なら ↩️ 取り消す** で戻せます。' +
              '\n管理者が **⚙️ 管理 → 📌 報告パネル** で置くと、専用チャンネルにボタンだけのメッセージが残ります。以後は `/menu` を開かずワンタップで報告できます。',
          },
          {
            name: '🔥 連日ボーナス・🏅 称号',
            value:
              '連続日数はアクションごとに数えます。決められた日数に届くとボーナスが出て、条件を満たすと称号も自動で贈られます。**お財布 → 🏅 称号・連続記録** から、持っている称号を1つ選んで名前の横に表示できます。' +
              (describeDayStart(ctx.calendar) ? `\n**${describeDayStart(ctx.calendar)}。** 深夜に報告しても前の日の続きとして数えます。` : ''),
          },
          ...gameHelp(settings),
          {
            name: '🛍️ ショップ',
            value:
              '自分で値段を決めて出品できます。売れた代金はそのまま出品者に入ります。並べ替えと🔍検索ができ、出品のお知らせの **🛒 見る・買う** からも買えます。使い切りのアイテムが使われたら、出品者は「✅ 対応した」で受け渡しを記録できます。',
          },
          {
            name: '💰 お財布',
            value:
              '所持金の確認・送金・増減の履歴（絞り込みと日ごとの合計つき）・ランキング・**📊 戦績**・**👤 プロフィール**が見られます。' +
              '\nメンバーを **右クリック（スマホは長押し）→ アプリ** から、その人のプロフィールを見たり、コインを送ったりもできます。',
          },
          {
            name: '🔐 自分のデータ',
            value:
              '**お財布 → 🔐 自分のデータ** から、保存されている内容の確認と削除がいつでもできます。メッセージの本文は読んでいません。' +
              'プロフィールをほかの人に見せたくなければ **👤 プロフィール → 🙈 見せないにする** を押してください。',
          },
          {
            name: '⚖️ 決まりごと',
            value:
              `${currency}は遊びのための数字です。**現金・電子マネー・ギフト券などと交換することはできません**（出品やメモでの交換の持ちかけも禁止です）。`,
          },
        ],
      }),
    ],
    components: [row(homeButton())],
  });
}

/**
 * ヘルプの「あそぶ」の部分。ゲームの名簿（game-catalog.js）から作るので、
 * ゲームを増やしても載せ忘れが起きない。オフにしたゲームは出さない。
 */
function gameHelp(settings) {
  const playable = enabledGames(settings);
  return Object.entries(CATEGORIES)
    .map(([key, meta]) => {
      const games = gamesIn(playable, key);
      if (games.length === 0) return null;
      return {
        name: `🎮 あそぶ（${meta.emoji} ${meta.label}）`,
        value: truncate(games.map((game) => `${game.emoji} **${game.name}** — ${game.hint}`).join('\n'), 1024),
      };
    })
    .filter(Boolean);
}

/**
 * 自分だけに見えている結果を、チャンネルに出す。
 * 押されたメッセージ（Bot が出したもの）をそのまま写すので、作り話は混ざらない。
 * 一度見せたら、その画面からはボタンを外す（同じものが何度も流れないように）。
 */
export async function share(ix, _args, ctx) {
  const message = ix.raw.message;
  if (!message?.embeds?.length) return open(ix, [], ctx, '見せられるものがありませんでした。');

  const posted = {
    content: message.content ?? '',
    embeds: [
      embed({ color: 0x5865f2, description: `📣 <@${ix.userId}> が結果を見せてくれました` }),
      ...message.embeds.slice(0, 4).map(plainEmbed),
    ],
    allowed_mentions: { parse: [] },
  };
  ctx.announce(ix.channelId, posted);

  // 画面はそのまま、見せるボタンだけを外す
  const components = (message.components ?? [])
    .map((actionRow) => ({
      ...actionRow,
      components: (actionRow.components ?? []).filter((component) => component.custom_id !== id('home', 'share')),
    }))
    .filter((actionRow) => actionRow.components.length > 0);
  return show(ix, { content: message.content ?? '', embeds: message.embeds.map(plainEmbed), components });
}

export const actions = { open, help, share };
