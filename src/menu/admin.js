import { PRESET_ACTIVITIES, getActivity, listActivities, removeActivity, upsertActivity } from '../lib/activities.js';
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
        button(id('admin', 'bal'), '残高を調整', { emoji: '💰', style: ButtonStyle.PRIMARY }),
        button(id('admin', 'cfg'), '通貨の設定', { emoji: '⚙️' }),
      ),
      row(backButton()),
    ],
  });
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
