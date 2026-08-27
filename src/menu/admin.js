import { PRESET_ACTIVITIES, getActivity, listActivities, removeActivity, upsertActivity } from '../lib/activities.js';
import {
  CONDITION_TYPES,
  createAchievement,
  describeCondition,
  listAchievements,
  removeAchievement,
} from '../lib/achievements.js';
import { listStreakRewards, removeStreakReward, upsertStreakReward } from '../lib/streak.js';
import { adjust, getBalance, ledgerFor, setBalance, updateSettings } from '../lib/economy.js';
import { coins, duration, truncate } from '../lib/format.js';
import { modal, stringSelect, textInput, userSelect } from '../discord/builders.js';
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
import { open as openHome } from './home.js';
import { reasonLabel } from './wallet.js';

/** 管理操作は毎回権限を確かめる。権限が無ければホームに戻す。 */
function denied(ix, ctx) {
  return openHome(ix, [], ctx, 'この操作には「サーバー管理」権限が必要です。');
}

export async function open(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x9b59b6,
          title: '⚙️ 管理メニュー',
          description: 'サーバー管理権限を持つ人だけが使えます。',
          fields: [
            { name: '通貨', value: `${settings.currency_emoji} ${settings.currency_name}`, inline: true },
            { name: '初期残高', value: `${settings.starting_balance}`, inline: true },
            {
              name: '賭け金',
              value: `${settings.min_bet} 〜 ${settings.max_bet === 0 ? '無制限' : settings.max_bet}`,
              inline: true,
            },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('admin', 'acts'), 'アクション管理', { emoji: '📋', style: ButtonStyle.PRIMARY }),
        button(id('admin', 'streak'), '連日ボーナス', { emoji: '🔥', style: ButtonStyle.PRIMARY }),
        button(id('admin', 'ach'), '称号', { emoji: '🏅', style: ButtonStyle.PRIMARY }),
      ),
      row(
        button(id('admin', 'bal'), '残高を調整', { emoji: '💰' }),
        button(id('admin', 'cfg'), '通貨の設定', { emoji: '⚙️' }),
      ),
      row(backButton()),
    ],
  });
}

/* ------------------------------------------------------------------ 連日ボーナス */

export async function streak(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const rewards = await listStreakRewards(ctx.db, ix.guildId);

  const components = [];
  if (rewards.length > 0) {
    components.push(
      stringSelect(
        id('admin', 'streakdel'),
        '削除するものを選ぶ',
        rewards.map((reward) => ({
          label: `${reward.days}日連続 → ${reward.reward}`,
          value: String(reward.days),
          description: '選ぶと削除されます',
        })),
      ),
    );
  }
  components.push(
    row(button(id('admin', 'streaknew'), '追加・変更', { emoji: '➕', style: ButtonStyle.SUCCESS })),
    row(backButton('admin'), homeButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🔥 連日ボーナス',
          description:
            rewards.length === 0
              ? '毎日続けて報告した人へのボーナスを設定できます。\n例:「3日連続で50コイン」「7日連続で200コイン」\n\nまだ何も設定されていません。'
              : '報告の連続日数が**ちょうどその日数に達したとき**に支払われます。\n\n' +
                rewards.map((reward) => `🔥 **${reward.days}日連続** → ${coins(reward.reward, settings)}`).join('\n'),
          footer: { text: '連続が途切れると1日目からやり直しになります' },
        }),
        notice,
      ),
    ],
    components,
  });
}

export async function streaknew(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return openModal(
    modal(id('admin', 'streaksave'), '連日ボーナスを追加', [
      textInput('days', '何日連続で', { placeholder: '例: 7', required: true, max: 6 }),
      textInput('reward', 'もらえるコイン', { placeholder: '例: 200', required: true, max: 12 }),
    ]),
  );
}

export async function streaksave(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const days = readInt(ix, 'days', { min: 1, max: 3650 });
  const reward = readInt(ix, 'reward', { min: 1 });
  if (isError(days)) return streak(ix, [], ctx, days.error);
  if (isError(reward)) return streak(ix, [], ctx, reward.error);
  if (days === null || reward === null) return streak(ix, [], ctx, '日数とコインの両方を入力してください。');

  await upsertStreakReward(ctx.db, ix.guildId, days, reward);
  return streak(ix, [], ctx, `${days}日連続のボーナスを ${reward} に設定しました`);
}

export async function streakdel(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const days = Number(ix.values[0]);
  await removeStreakReward(ctx.db, ix.guildId, days);
  return streak(ix, [], ctx, `${days}日連続のボーナスを削除しました`);
}

/* ------------------------------------------------------------------ 称号 */

export async function ach(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const achievements = await listAchievements(ctx.db, ix.guildId);

  const components = [];
  if (achievements.length > 0) {
    components.push(
      stringSelect(
        id('admin', 'achdel'),
        '削除する称号を選ぶ',
        achievements.map((achievement) => ({
          label: truncate(achievement.name, 100),
          value: String(achievement.id),
          emoji: achievement.emoji ?? undefined,
          description: truncate(describeCondition(achievement, settings), 100),
        })),
      ),
    );
  }
  components.push(
    row(button(id('admin', 'achnew'), '新しく作る', { emoji: '➕', style: ButtonStyle.SUCCESS })),
    row(backButton('admin'), homeButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf39c12,
          title: '🏅 称号',
          description:
            achievements.length === 0
              ? '条件を満たした人に自動で贈られる称号を作れます。\n例:「筋トレ王 = 筋トレ100回」「鉄の意志 = 30日連続」\n\nまだ何も作られていません。'
              : achievements
                  .map(
                    (achievement) =>
                      `${achievement.emoji ?? '🏅'} **${achievement.name}** — ${describeCondition(achievement, settings)}` +
                      (achievement.reward > 0 ? `（+${achievement.reward}）` : ''),
                  )
                  .join('\n'),
          footer: { text: '条件を満たすと自動で贈られ、チャンネルにも告知されます' },
        }),
        notice,
      ),
    ],
    components,
  });
}

export async function achnew(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return show(ix, {
    embeds: [
      embed({
        color: 0xf39c12,
        title: '🏅 称号を作る',
        description: 'まず、どんな条件で贈るかを選んでください。',
        fields: Object.entries(CONDITION_TYPES).map(([key, type]) => ({
          name: type.label,
          value: EXAMPLES[key],
          inline: true,
        })),
      }),
    ],
    components: [
      stringSelect(
        id('admin', 'achtype'),
        '条件の種類を選ぶ',
        Object.entries(CONDITION_TYPES).map(([key, type]) => ({
          label: type.label,
          value: key,
          description: truncate(EXAMPLES[key], 100),
        })),
      ),
      row(backButton('admin', '管理メニュー'), button(id('admin', 'ach'), '称号一覧', { emoji: '🏅' })),
    ],
  });
}

const EXAMPLES = {
  total_reports: '例: 報告を合計100回で「継続の鬼」',
  activity_reports: '例: 筋トレを50回で「筋トレ王」',
  streak: '例: 30日連続で「鉄の意志」',
  balance: '例: 所持金10000で「富豪」',
};

export async function achtype(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const type = ix.values[0];
  const meta = CONDITION_TYPES[type];
  if (!meta) return ach(ix, [], ctx, '不明な条件です。');

  const inputs = [
    textInput('name', '称号の名前', { placeholder: '例: 筋トレ王', required: true, max: 32 }),
    textInput('emoji', '絵文字（任意）', { placeholder: '例: 💪', max: 8 }),
    textInput('threshold', `条件の数（${meta.label}）`, { placeholder: '例: 100', required: true, max: 12 }),
    textInput('reward', '獲得時のボーナス（任意）', { placeholder: '例: 500', max: 12 }),
  ];
  if (meta.needsActivity) {
    inputs.push(textInput('activity', '対象のアクション名', { placeholder: '例: 筋トレ', required: true, max: 32 }));
  }

  return openModal(modal(id('admin', 'achsave', type), `称号を作る（${meta.label}）`, inputs));
}

export async function achsave(ix, [type], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const meta = CONDITION_TYPES[type];
  if (!meta) return ach(ix, [], ctx, '不明な条件です。');

  const name = readText(ix, 'name');
  const threshold = readInt(ix, 'threshold', { min: 1 });
  const reward = readInt(ix, 'reward', { min: 0, fallback: 0 });
  const activityName = meta.needsActivity ? readText(ix, 'activity') : null;

  if (!name) return ach(ix, [], ctx, '称号の名前を入力してください。');
  if (isError(threshold)) return ach(ix, [], ctx, threshold.error);
  if (threshold === null) return ach(ix, [], ctx, '条件の数を入力してください。');
  if (isError(reward)) return ach(ix, [], ctx, reward.error);
  if (meta.needsActivity) {
    if (!activityName) return ach(ix, [], ctx, '対象のアクション名を入力してください。');
    if (!(await getActivity(ctx.db, ix.guildId, activityName))) {
      return ach(ix, [], ctx, `「${activityName}」というアクションは登録されていません。先にアクション管理で追加してください。`);
    }
  }

  await createAchievement(ctx.db, ix.guildId, {
    name,
    emoji: readText(ix, 'emoji'),
    condition_type: type,
    threshold,
    activity_name: activityName,
    reward: reward ?? 0,
  });
  return ach(ix, [], ctx, `称号「${name}」を作りました`);
}

export async function achdel(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const id2 = Number(ix.values[0]);
  await removeAchievement(ctx.db, ix.guildId, id2);
  return ach(ix, [], ctx, '称号を削除しました');
}

/* ------------------------------------------------------------------ アクション管理 */

export async function acts(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const activities = await listActivities(ctx.db, ix.guildId);

  const components = [];
  if (activities.length > 0) {
    components.push(
      stringSelect(
        id('admin', 'actpick'),
        '編集するアクションを選ぶ',
        activities.map((activity) => ({
          label: truncate(activity.name, 100),
          value: activity.name,
          emoji: activity.emoji ?? undefined,
          description: truncate(
            `報酬 ${activity.reward} / ${activity.cooldown_sec > 0 ? `${duration(activity.cooldown_sec)}おき` : 'CDなし'}`,
            100,
          ),
        })),
      ),
    );
  }
  components.push(
    row(
      button(id('admin', 'actnew'), '新しく追加', { emoji: '➕', style: ButtonStyle.SUCCESS }),
      button(id('admin', 'preset'), 'おすすめを一括登録', { emoji: '📦' }),
    ),
    row(backButton('admin'), homeButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x9b59b6,
          title: '📋 アクション管理',
          description:
            activities.length === 0
              ? 'まだアクションがありません。**おすすめを一括登録** が手軽です。'
              : activities.map(describe).join('\n'),
        }),
        notice,
      ),
    ],
    components,
  });
}

function describe(activity) {
  const bits = [`報酬 ${activity.reward}`];
  bits.push(activity.cooldown_sec > 0 ? `${duration(activity.cooldown_sec)}おき` : 'CDなし');
  bits.push(activity.daily_limit > 0 ? `1日${activity.daily_limit}回` : '回数無制限');
  return `${activity.emoji ?? '•'} **${activity.name}** — ${bits.join(' / ')}`;
}

export async function actpick(ix, _args, ctx) {
  return actview(ix, [ix.values[0]], ctx);
}

export async function actview(ix, args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const name = args.join(':');
  const activity = await getActivity(ctx.db, ix.guildId, name);
  if (!activity) return acts(ix, [], ctx, 'そのアクションは見つかりませんでした。');

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x9b59b6,
          title: `${activity.emoji ?? '📋'} ${activity.name}`,
          description: activity.description ?? '説明なし',
          fields: [
            { name: '報酬', value: `${activity.reward}`, inline: true },
            {
              name: 'クールダウン',
              value: activity.cooldown_sec > 0 ? duration(activity.cooldown_sec) : 'なし',
              inline: true,
            },
            { name: '1日の上限', value: activity.daily_limit > 0 ? `${activity.daily_limit} 回` : '無制限', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('admin', 'actedit', activity.name), '編集', { emoji: '✏️', style: ButtonStyle.PRIMARY }),
        button(id('admin', 'actdel', activity.name), '削除', { emoji: '🗑️', style: ButtonStyle.DANGER }),
      ),
      row(backButton('admin', '管理メニュー'), button(id('admin', 'acts'), 'アクション一覧', { emoji: '📋' }), homeButton()),
    ],
  });
}

function activityModal(customId, title, activity = null) {
  return modal(customId, title, [
    textInput('name', 'アクション名', { placeholder: '例: 筋トレ', value: activity?.name, max: 32, required: true }),
    textInput('reward', 'もらえるコイン', {
      placeholder: '例: 50',
      value: activity ? String(activity.reward) : '',
      max: 12,
      required: true,
    }),
    textInput('cooldown', 'クールダウン（分・空欄でなし）', {
      placeholder: '例: 360',
      value: activity && activity.cooldown_sec > 0 ? String(Math.round(activity.cooldown_sec / 60)) : '',
      max: 12,
    }),
    textInput('daily', '1日の上限回数（空欄で無制限）', {
      placeholder: '例: 2',
      value: activity && activity.daily_limit > 0 ? String(activity.daily_limit) : '',
      max: 12,
    }),
    textInput('emoji', '絵文字（任意）', { placeholder: '例: 💪', value: activity?.emoji ?? '', max: 8 }),
  ]);
}

export async function actnew(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return openModal(activityModal(id('admin', 'actsave'), 'アクションを追加'));
}

export async function actedit(ix, args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const name = args.join(':');
  const activity = await getActivity(ctx.db, ix.guildId, name);
  if (!activity) return acts(ix, [], ctx, 'そのアクションは見つかりませんでした。');
  return openModal(activityModal(id('admin', 'actsave2', activity.name), `${activity.name} を編集`, activity));
}

export async function actsave(ix, _args, ctx) {
  return saveActivity(ix, ctx, null);
}

export async function actsave2(ix, args, ctx) {
  return saveActivity(ix, ctx, args.join(':'));
}

async function saveActivity(ix, ctx, previousName) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const name = readText(ix, 'name');
  const reward = readInt(ix, 'reward', { min: 0 });
  const cooldown = readInt(ix, 'cooldown', { min: 0, fallback: 0 });
  const daily = readInt(ix, 'daily', { min: 0, fallback: 0 });

  if (!name) return acts(ix, [], ctx, 'アクション名を入力してください。');
  if (isError(reward)) return acts(ix, [], ctx, reward.error);
  if (isError(cooldown)) return acts(ix, [], ctx, cooldown.error);
  if (isError(daily)) return acts(ix, [], ctx, daily.error);

  const previous = previousName ? await getActivity(ctx.db, ix.guildId, previousName) : null;
  await upsertActivity(ctx.db, ix.guildId, {
    name,
    reward,
    cooldown_sec: cooldown * 60,
    daily_limit: daily,
    emoji: readText(ix, 'emoji'),
    description: previous?.description ?? null,
  });
  // 名前を変えた場合は古い方を消す（報告履歴は旧名のまま残る）
  if (previous && previous.name !== name) await removeActivity(ctx.db, ix.guildId, previous.name);

  return actview(ix, [name], ctx, previous ? '更新しました' : '追加しました');
}

export async function actdel(ix, args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const name = args.join(':');
  await removeActivity(ctx.db, ix.guildId, name);
  return acts(ix, [], ctx, `「${name}」を削除しました`);
}

export async function preset(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const added = [];
  for (const item of PRESET_ACTIVITIES) {
    if (await getActivity(ctx.db, ix.guildId, item.name)) continue;
    await upsertActivity(ctx.db, ix.guildId, item);
    added.push(item.name);
  }
  return acts(ix, [], ctx, added.length > 0 ? `登録しました: ${added.join('、')}` : 'すべて登録済みです');
}

/* ------------------------------------------------------------------ 残高調整 */

export async function bal(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return show(ix, {
    embeds: [
      withNotice(
        embed({ color: 0x9b59b6, title: '💰 残高を調整', description: '対象のメンバーを選んでください。' }),
        notice,
      ),
    ],
    components: [userSelect(id('admin', 'baluser'), 'メンバーを選ぶ'), row(backButton('admin'), homeButton())],
  });
}

export async function baluser(ix, _args, ctx) {
  return balview(ix, [ix.values[0]], ctx);
}

export async function balview(ix, [userId], ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x9b59b6,
          title: '💰 残高を調整',
          description: `対象: <@${userId}>\n現在の所持金 ${coins(balance, settings)}`,
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('admin', 'balmodal', 'give', userId), '配る', { emoji: '➕', style: ButtonStyle.SUCCESS }),
        button(id('admin', 'balmodal', 'take', userId), '回収する', { emoji: '➖', style: ButtonStyle.DANGER }),
        button(id('admin', 'balmodal', 'set', userId), '金額を設定', { emoji: '🎯' }),
      ),
      row(
        button(id('admin', 'balhist', userId), '履歴を見る', { emoji: '📜' }),
        backButton('admin', '管理メニュー'),
        button(id('admin', 'bal'), '別の人', { emoji: '🔄' }),
        homeButton(),
      ),
    ],
  });
}

const MODE_LABEL = { give: '配る', take: '回収する', set: '金額を設定' };

export async function balmodal(ix, [mode, userId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return openModal(
    modal(id('admin', 'balapply', mode, userId), MODE_LABEL[mode] ?? '残高調整', [
      textInput('amount', '金額', { required: true, max: 12 }),
      textInput('reason', '理由（任意）', { max: 100 }),
    ]),
  );
}

export async function balapply(ix, [mode, userId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const amount = readInt(ix, 'amount', { min: 0 });
  if (isError(amount)) return balview(ix, [userId], ctx, amount.error);
  const reason = readText(ix, 'reason');

  const balance =
    mode === 'set'
      ? await setBalance(ctx.db, ix.guildId, userId, amount, 'admin:set', reason)
      : await adjust(ctx.db, ix.guildId, userId, mode === 'give' ? amount : -amount, `admin:${mode}`, reason);

  if (mode === 'give' && amount > 0) {
    ctx.announce(ix.channelId, {
      content: `🎁 <@${userId}> に ${coins(amount, settings)} が配られました。${reason ? `\n> ${reason}` : ''}`,
      allowed_mentions: { users: [userId] },
    });
  }

  return balview(ix, [userId], ctx, `${MODE_LABEL[mode]}を実行しました（現在 ${balance}）`);
}

export async function balhist(ix, [userId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const entries = await ledgerFor(ctx.db, ix.guildId, userId, 15);

  return show(ix, {
    embeds: [
      embed({
        color: 0x9b59b6,
        title: '📜 コインの履歴',
        description:
          entries.length === 0
            ? 'まだ履歴がありません。'
            : `対象: <@${userId}>\n\n` +
              entries
                .map((entry) => {
                  const sign = entry.amount >= 0 ? '+' : '';
                  return `<t:${Math.floor(entry.created_at / 1000)}:R>　\`${sign}${entry.amount}\`　${reasonLabel(entry)}`;
                })
                .join('\n'),
      }),
    ],
    components: [row(button(id('admin', 'balview', userId), '戻る', { emoji: '◀️' }), homeButton())],
  });
}

/* ------------------------------------------------------------------ 通貨設定 */

export async function cfg(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);

  return openModal(
    modal(id('admin', 'cfgsave'), '通貨の設定', [
      textInput('currency_name', '通貨の名前', { value: settings.currency_name, max: 16 }),
      textInput('currency_emoji', '通貨の絵文字', { value: settings.currency_emoji, max: 8 }),
      textInput('starting_balance', '新規メンバーの初期残高', { value: String(settings.starting_balance), max: 12 }),
      textInput('min_bet', '最低賭け金', { value: String(settings.min_bet), max: 12 }),
      textInput('max_bet', '最高賭け金（0で無制限）', { value: String(settings.max_bet), max: 12 }),
    ]),
  );
}

export async function cfgsave(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const starting = readInt(ix, 'starting_balance', { min: 0 });
  const minBet = readInt(ix, 'min_bet', { min: 1 });
  const maxBet = readInt(ix, 'max_bet', { min: 0 });
  for (const value of [starting, minBet, maxBet]) {
    if (isError(value)) return open(ix, [], ctx, value.error);
  }
  if (maxBet !== null && minBet !== null && maxBet > 0 && maxBet < minBet) {
    return open(ix, [], ctx, '最高賭け金は最低賭け金以上にしてください。');
  }

  await updateSettings(ctx.db, ix.guildId, {
    currency_name: readText(ix, 'currency_name'),
    currency_emoji: readText(ix, 'currency_emoji'),
    starting_balance: starting,
    min_bet: minBet,
    max_bet: maxBet,
  });
  ctx.forgetSettings(ix.guildId);
  return open(ix, [], ctx, '設定を保存しました');
}

export const actions = {
  open,
  streak,
  streaknew,
  streaksave,
  streakdel,
  ach,
  achnew,
  achtype,
  achsave,
  achdel,
  acts,
  actpick,
  actview,
  actnew,
  actedit,
  actsave,
  actsave2,
  actdel,
  preset,
  bal,
  baluser,
  balview,
  balmodal,
  balapply,
  balhist,
  cfg,
  cfgsave,
};
