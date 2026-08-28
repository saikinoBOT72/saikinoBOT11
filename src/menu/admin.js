import { PRESET_ACTIVITIES, getActivity, listActivities, removeActivity, upsertActivity } from '../lib/activities.js';
import {
  CONDITION_EXAMPLES,
  CONDITION_TYPES,
  createAchievement,
  describeCondition,
  listAchievements,
  removeAchievement,
} from '../lib/achievements.js';
import {
  describeStreakReward,
  listStreakRewards,
  removeStreakReward,
  removeStreakRewardsFor,
  upsertStreakReward,
} from '../lib/streak.js';
import { adjust, getBalance, ledgerFor, setBalance, updateSettings } from '../lib/economy.js';
import { coins, duration, truncate } from '../lib/format.js';
import { channelSelect, modal, stringSelect, textInput, userSelect } from '../discord/builders.js';
import {
  WEEKDAYS,
  createAnnouncement,
  describeAnnouncement,
  describeSchedule,
  getAnnouncement,
  listAnnouncements,
  removeAnnouncement,
  toggleAnnouncement,
} from '../lib/announcements.js';
import { METRICS, rankingTitle } from '../lib/ranking.js';
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
        button(id('admin', 'ann'), '定期発表', { emoji: '📢', style: ButtonStyle.PRIMARY }),
        button(id('admin', 'bal'), '残高を調整', { emoji: '💰' }),
        button(id('admin', 'cfg'), '通貨の設定', { emoji: '⚙️' }),
      ),
      row(backButton()),
    ],
  });
}

/* ------------------------------------------------------------------ 連日ボーナス（アクションごと） */

export async function streak(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const settings = await ctx.settings(ix.guildId);
  const [activities, rewards] = await Promise.all([
    listActivities(ctx.db, ix.guildId),
    listStreakRewards(ctx.db, ix.guildId),
  ]);

  if (activities.length === 0) {
    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: 0xe67e22,
            title: '🔥 連日ボーナス',
            description: '先に **📋 アクション管理** でアクションを作ってください。連日ボーナスはアクションごとに設定します。',
          }),
          notice,
        ),
      ],
      components: [row(backButton('admin'), homeButton())],
    });
  }

  const summary = activities.map((activity) => {
    const own = rewards.filter((reward) => reward.activity === activity.name);
    const detail =
      own.length === 0
        ? '未設定'
        : own.map((reward) => describeStreakReward(reward, settings)).join('、');
    return `${activity.emoji ?? '•'} **${activity.name}** — ${detail}`;
  });

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🔥 連日ボーナス',
          description:
            'アクションごとに「何日目から何日目までは毎日何コイン」を決められます。\n連続はアクション別に数えるので、筋トレと勉強は別々です。\n\n' +
            summary.join('\n'),
          footer: { text: '1日空くとそのアクションの連続は1日目に戻ります' },
        }),
        notice,
      ),
    ],
    components: [
      stringSelect(
        id('admin', 'streakact'),
        '設定するアクションを選ぶ',
        activities.map((activity) => ({
          label: truncate(activity.name, 100),
          value: activity.name,
          emoji: activity.emoji ?? undefined,
          description: truncate(
            rewards.filter((reward) => reward.activity === activity.name).length > 0 ? '設定済み' : 'まだ未設定',
            100,
          ),
        })),
      ),
      row(backButton('admin'), homeButton()),
    ],
  });
}

export async function streakact(ix, _args, ctx) {
  return streakview(ix, [ix.values[0]], ctx);
}

export async function streakview(ix, args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const activity = args.join(':');
  const settings = await ctx.settings(ix.guildId);
  const rewards = await listStreakRewards(ctx.db, ix.guildId, activity);

  const components = [];
  if (rewards.length > 0) {
    components.push(
      stringSelect(
        id('admin', 'streakdel', activity),
        '削除するものを選ぶ',
        rewards.map((reward) => ({
          label: truncate(describeStreakReward(reward, null), 100),
          value: String(reward.from_days),
          description: '選ぶと削除されます',
        })),
      ),
    );
  }
  components.push(
    row(button(id('admin', 'streaknew', activity), '追加・変更', { emoji: '➕', style: ButtonStyle.SUCCESS })),
    row(backButton('admin', '管理メニュー'), button(id('admin', 'streak'), '別のアクション', { emoji: '🔄' }), homeButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: `🔥 ${activity} の連日ボーナス`,
          description:
            rewards.length === 0
              ? 'まだ設定されていません。\n例:\n・3〜6日目は毎日 50\n・7〜13日目は毎日 100\n・14日目以降は毎日 200\nのように段階を作ると続きやすくなります。'
              : rewards
                  .map((reward) => {
                    const range =
                      reward.to_days === 0 ? `**${reward.from_days}日目以降**` : `**${reward.from_days}〜${reward.to_days}日目**`;
                    return `🔥 ${range} は毎日 ${coins(reward.reward, settings)}`;
                  })
                  .join('\n'),
          footer: { text: '連続日数がその範囲にあるあいだ、報告するたび毎日もらえます' },
        }),
        notice,
      ),
    ],
    components,
  });
}

export async function streaknew(ix, args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const activity = args.join(':');
  return openModal(
    modal(id('admin', 'streaksave', activity), `${truncate(activity, 24)} の連日ボーナス`, [
      textInput('from_days', '何日目から', { placeholder: '例: 3', required: true, max: 6 }),
      textInput('to_days', '何日目まで（空欄ならそれ以降ずっと）', { placeholder: '例: 6', max: 6 }),
      textInput('reward', 'そのあいだ毎日もらえるコイン', { placeholder: '例: 50', required: true, max: 12 }),
    ]),
  );
}

export async function streaksave(ix, args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const activity = args.join(':');
  const fromDays = readInt(ix, 'from_days', { min: 1, max: 3650 });
  const toDays = readInt(ix, 'to_days', { min: 0, max: 3650, fallback: 0 });
  const reward = readInt(ix, 'reward', { min: 1 });

  if (isError(fromDays)) return streakview(ix, [activity], ctx, fromDays.error);
  if (isError(toDays)) return streakview(ix, [activity], ctx, toDays.error);
  if (isError(reward)) return streakview(ix, [activity], ctx, reward.error);
  if (fromDays === null || reward === null) {
    return streakview(ix, [activity], ctx, '「何日目から」と「もらえるコイン」は必ず入力してください。');
  }
  if (toDays !== 0 && toDays < fromDays) {
    return streakview(ix, [activity], ctx, '「何日目まで」は「何日目から」以上にしてください（空欄ならそれ以降ずっと）。');
  }

  await upsertStreakReward(ctx.db, ix.guildId, activity, fromDays, toDays, reward);
  const range = toDays === 0 ? `${fromDays}日目以降` : `${fromDays}〜${toDays}日目`;
  return streakview(ix, [activity], ctx, `${range} は毎日 ${reward} に設定しました`);
}

export async function streakdel(ix, args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const activity = args.join(':');
  const fromDays = Number(ix.values[0]);
  await removeStreakReward(ctx.db, ix.guildId, activity, fromDays);
  return streakview(ix, [activity], ctx, `${fromDays}日目からの設定を削除しました`);
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
              ? '条件を満たした人に自動で贈られる称号を作れます。\n獲得した人は名前の横に表示できます。\n\nまだ何も作られていません。'
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
          value: CONDITION_EXAMPLES[key],
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
          description: truncate(CONDITION_EXAMPLES[key], 100),
        })),
      ),
      row(backButton('admin', '管理メニュー'), button(id('admin', 'ach'), '称号一覧', { emoji: '🏅' })),
    ],
  });
}

export async function achtype(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const type = ix.values[0];
  const meta = CONDITION_TYPES[type];
  if (!meta) return ach(ix, [], ctx, '不明な条件です。');

  const inputs = [
    textInput('name', '称号の名前', { placeholder: '例: 筋トレ王', required: true, max: 32 }),
    textInput('emoji', '絵文字（任意）', { placeholder: '例: 💪', max: 8 }),
    textInput('threshold', `条件の数（${meta.unit || 'コイン'}）`, { placeholder: '例: 100', required: true, max: 12 }),
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
  await removeAchievement(ctx.db, ix.guildId, Number(ix.values[0]));
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
  await removeStreakRewardsFor(ctx.db, ix.guildId, name);
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


/* ------------------------------------------------------------------ 定期発表 */

export async function ann(ix, _args, ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const list = await listAnnouncements(ctx.db, ix.guildId);

  const components = [];
  if (list.length > 0) {
    components.push(
      stringSelect(
        id('admin', 'annpick'),
        '設定を選んで停止・削除する',
        list.map((announcement) => ({
          label: truncate(
            rankingTitle({
              metric: announcement.metric,
              activityName: announcement.activity_name,
              period: announcement.frequency === 'weekly' ? 'week' : 'day',
            }),
            100,
          ),
          value: String(announcement.id),
          description: truncate(`${describeSchedule(announcement)}${announcement.enabled ? '' : '・停止中'}`, 100),
        })),
      ),
    );
  }
  components.push(
    row(button(id('admin', 'annnew'), '新しく作る', { emoji: '➕', style: ButtonStyle.SUCCESS })),
    row(backButton('admin'), homeButton()),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x3498db,
          title: '📢 定期発表',
          description:
            list.length === 0
              ? '決まった時間にランキングを自動で発表できます。\n「毎朝9時に今日の筋トレ連続記録」「毎週月曜に先週稼いだコイン」など。\n\nまだ何も設定されていません。'
              : list
                  .map((announcement) => `${announcement.enabled ? '🟢' : '⚪'} <#${announcement.channel_id}> ${describeAnnouncement(announcement)}`)
                  .join('\n'),
          footer: { text: '時刻は ' + ctx.timezone + ' 基準です' },
        }),
        notice,
      ),
    ],
    components,
  });
}

export async function annnew(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  return show(ix, {
    embeds: [
      embed({
        color: 0x3498db,
        title: '📢 定期発表を作る（1/4）',
        description: 'まず、どのチャンネルに発表するかを選んでください。',
      }),
    ],
    components: [channelSelect(id('admin', 'annch'), '発表するチャンネルを選ぶ'), row(backButton('admin', 'やめる'))],
  });
}

export async function annch(ix, _args, ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const channelId = ix.values[0];
  return show(ix, {
    embeds: [
      embed({
        color: 0x3498db,
        title: '📢 定期発表を作る（2/4）',
        description: `発表先: <#${channelId}>\n\n何のランキングを出しますか？`,
        fields: Object.entries(METRICS).map(([key, meta]) => ({
          name: meta.label,
          value: METRIC_HINTS[key],
          inline: true,
        })),
      }),
    ],
    components: [
      stringSelect(
        id('admin', 'annmetric', channelId),
        'ランキングの種類を選ぶ',
        Object.entries(METRICS).map(([key, meta]) => ({
          label: meta.label,
          value: key,
          description: truncate(METRIC_HINTS[key], 100),
        })),
      ),
      row(backButton('admin', 'やめる')),
    ],
  });
}

const METRIC_HINTS = {
  balance: 'いま誰が一番持っているか',
  earned: '期間内にどれだけ増やしたか',
  activity_count: '期間内に何回報告したか',
  activity_total: 'これまでの合計回数',
  activity_streak: 'いま何日続いているか',
};

export async function annmetric(ix, [channelId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const metric = ix.values[0];
  if (!METRICS[metric]) return ann(ix, [], ctx, '不明な種類です。');

  const options = [
    { label: '毎日', value: 'daily', description: '毎日その時刻に発表します' },
    ...WEEKDAYS.map((name, index) => ({
      label: `毎週 ${name}`,
      value: `w${index}`,
      description: `${name}にだけ発表します`,
    })),
  ];

  return show(ix, {
    embeds: [
      embed({
        color: 0x3498db,
        title: '📢 定期発表を作る（3/4）',
        description:
          `発表先: <#${channelId}>\n種類: **${METRICS[metric].label}**\n\nどのくらいの頻度で発表しますか？\n` +
          (METRICS[metric].usesPeriod
            ? '*毎日を選ぶと「今日」の集計、毎週を選ぶと「今週」の集計になります。*'
            : '*この種類は集計期間に関係なく、いまの状態で並べます。*'),
      }),
    ],
    components: [
      stringSelect(id('admin', 'annwhen', channelId, metric), '頻度を選ぶ', options),
      row(backButton('admin', 'やめる')),
    ],
  });
}

export async function annwhen(ix, [channelId, metric], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const when = ix.values[0];
  const meta = METRICS[metric];
  if (!meta) return ann(ix, [], ctx, '不明な種類です。');

  const inputs = [
    textInput('hour', '発表する時刻（0〜23の数字）', { placeholder: '例: 9', required: true, max: 2 }),
    textInput('top_n', '何位まで出すか', { placeholder: '例: 5', required: true, max: 2, value: '5' }),
    textInput('prize', '1位への賞金（0でなし）', { placeholder: '例: 500', max: 12, value: '0' }),
  ];
  if (meta.needsActivity) {
    inputs.push(
      textInput('activity', meta.needsActivity === true ? '対象のアクション名' : '対象のアクション名（空欄で全部）', {
        placeholder: '例: 筋トレ',
        required: meta.needsActivity === true,
        max: 32,
      }),
    );
  }

  return openModal(modal(id('admin', 'annsave', channelId, metric, when), '発表の詳細（4/4）', inputs));
}

export async function annsave(ix, [channelId, metric, when], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const meta = METRICS[metric];
  if (!meta) return ann(ix, [], ctx, '不明な種類です。');

  const hour = readInt(ix, 'hour', { min: 0, max: 23 });
  const topN = readInt(ix, 'top_n', { min: 1, max: 20 });
  const prize = readInt(ix, 'prize', { min: 0, fallback: 0 });
  if (isError(hour)) return ann(ix, [], ctx, hour.error);
  if (hour === null) return ann(ix, [], ctx, '発表する時刻を入力してください。');
  if (isError(topN)) return ann(ix, [], ctx, topN.error);
  if (isError(prize)) return ann(ix, [], ctx, prize.error);

  let activityName = null;
  if (meta.needsActivity) {
    activityName = readText(ix, 'activity');
    if (meta.needsActivity === true && !activityName) {
      return ann(ix, [], ctx, 'この種類では対象のアクション名が必要です。');
    }
    if (activityName && !(await getActivity(ctx.db, ix.guildId, activityName))) {
      return ann(ix, [], ctx, `「${activityName}」というアクションは登録されていません。`);
    }
  }

  const created = await createAnnouncement(ctx.db, ix.guildId, {
    channelId,
    metric,
    activityName,
    frequency: when === 'daily' ? 'daily' : 'weekly',
    weekday: when === 'daily' ? null : Number(when.slice(1)),
    hour,
    topN: topN ?? 5,
    prize: prize ?? 0,
  });

  return ann(ix, [], ctx, `${describeSchedule(created)}に <#${channelId}> で発表します`);
}

export async function annpick(ix, _args, ctx) {
  return annview(ix, [ix.values[0]], ctx);
}

export async function annview(ix, [rawId], ctx, notice = null) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const announcement = await getAnnouncement(ctx.db, ix.guildId, Number(rawId));
  if (!announcement) return ann(ix, [], ctx, 'その設定は見つかりませんでした。');

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x3498db,
          title: '📢 発表の設定',
          description: `発表先: <#${announcement.channel_id}>\n${describeAnnouncement(announcement)}`,
          fields: [
            { name: '状態', value: announcement.enabled ? '🟢 有効' : '⚪ 停止中', inline: true },
            { name: '最後の発表', value: announcement.last_run_date ?? 'まだ', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('admin', 'anntoggle', String(announcement.id)), announcement.enabled ? '停止する' : '再開する', {
          emoji: announcement.enabled ? '⏸️' : '▶️',
          style: announcement.enabled ? ButtonStyle.SECONDARY : ButtonStyle.SUCCESS,
        }),
        button(id('admin', 'anndel', String(announcement.id)), '削除する', { emoji: '🗑️', style: ButtonStyle.DANGER }),
      ),
      row(backButton('admin', '管理メニュー'), button(id('admin', 'ann'), '一覧へ', { emoji: '📢' }), homeButton()),
    ],
  });
}

export async function anntoggle(ix, [rawId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  const updated = await toggleAnnouncement(ctx.db, ix.guildId, Number(rawId));
  return annview(ix, [rawId], ctx, updated?.enabled ? '再開しました' : '停止しました');
}

export async function anndel(ix, [rawId], ctx) {
  if (!ix.isAdmin) return denied(ix, ctx);
  await removeAnnouncement(ctx.db, ix.guildId, Number(rawId));
  return ann(ix, [], ctx, '設定を削除しました');
}

export const actions = {
  open,
  ann,
  annnew,
  annch,
  annmetric,
  annwhen,
  annsave,
  annpick,
  annview,
  anntoggle,
  anndel,
  streak,
  streakact,
  streakview,
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
