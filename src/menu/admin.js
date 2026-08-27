import {
  EmbedBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { PRESET_ACTIVITIES, getActivity, listActivities, removeActivity, upsertActivity } from '../lib/activities.js';
import { adjust, getBalance, getSettings, setBalance, updateSettings } from '../lib/economy.js';
import { getDb } from '../lib/db.js';
import { coins, duration, truncate } from '../lib/format.js';
import { announce, backButton, button, homeButton, id, isError, readInt, readText, row, show, toast } from './common.js';

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function guard(interaction) {
  if (isAdmin(interaction)) return true;
  await toast(interaction, 'この操作には「サーバー管理」権限が必要です。');
  return false;
}

export async function open(interaction) {
  if (!(await guard(interaction))) return undefined;
  const settings = getSettings(interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ 管理メニュー')
    .setDescription('サーバー管理権限を持つ人だけが使えます。')
    .addFields(
      { name: '通貨', value: `${settings.currency_emoji} ${settings.currency_name}`, inline: true },
      { name: '初期残高', value: `${settings.starting_balance}`, inline: true },
      { name: '賭け金', value: `${settings.min_bet} 〜 ${settings.max_bet === 0 ? '無制限' : settings.max_bet}`, inline: true },
    );

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('admin', 'acts'), 'アクション管理', { emoji: '📋', style: ButtonStyle.Primary }),
        button(id('admin', 'bal'), '残高を調整', { emoji: '💰', style: ButtonStyle.Primary }),
        button(id('admin', 'cfg'), '通貨の設定', { emoji: '⚙️' }),
      ),
      row(backButton()),
    ],
  });
}

/* ------------------------------------------------------------------ アクション管理 */

export async function acts(interaction, _args, notice = null) {
  if (!(await guard(interaction))) return undefined;
  const activities = listActivities(interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 アクション管理')
    .setDescription(
      activities.length === 0
        ? 'まだアクションがありません。**おすすめを一括登録** が手軽です。'
        : activities.map(describe).join('\n'),
    );
  if (notice) embed.setFooter({ text: notice });

  const components = [];
  if (activities.length > 0) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('admin', 'actpick'))
          .setPlaceholder('編集するアクションを選ぶ')
          .addOptions(
            activities.slice(0, 25).map((a) => ({
              label: truncate(a.name, 100),
              value: a.name,
              emoji: a.emoji ?? undefined,
              description: truncate(`報酬 ${a.reward} / ${a.cooldown_sec > 0 ? duration(a.cooldown_sec) + 'おき' : 'CDなし'}`, 100),
            })),
          ),
      ),
    );
  }
  components.push(
    row(
      button(id('admin', 'actnew'), '新しく追加', { emoji: '➕', style: ButtonStyle.Success }),
      button(id('admin', 'preset'), 'おすすめを一括登録', { emoji: '📦' }),
    ),
    row(backButton('admin'), homeButton()),
  );

  return show(interaction, { embeds: [embed], components });
}

function describe(a) {
  const bits = [`報酬 ${a.reward}`];
  bits.push(a.cooldown_sec > 0 ? `${duration(a.cooldown_sec)}おき` : 'CDなし');
  bits.push(a.daily_limit > 0 ? `1日${a.daily_limit}回` : '回数無制限');
  if (a.need_proof) bits.push('写真必須');
  return `${a.emoji ?? '•'} **${a.name}** — ${bits.join(' / ')}`;
}

export async function actpick(interaction) {
  return actview(interaction, [interaction.values[0]]);
}

export async function actview(interaction, args, notice = null) {
  if (!(await guard(interaction))) return undefined;
  const name = args.join(':');
  const activity = getActivity(interaction.guildId, name);
  if (!activity) return acts(interaction, [], 'そのアクションは見つかりませんでした。');

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`${activity.emoji ?? '📋'} ${activity.name}`)
    .setDescription(activity.description ?? '説明なし')
    .addFields(
      { name: '報酬', value: `${activity.reward}`, inline: true },
      { name: 'クールダウン', value: activity.cooldown_sec > 0 ? duration(activity.cooldown_sec) : 'なし', inline: true },
      { name: '1日の上限', value: activity.daily_limit > 0 ? `${activity.daily_limit} 回` : '無制限', inline: true },
      { name: '写真', value: activity.need_proof ? '必須' : '任意', inline: true },
    );
  if (notice) embed.setFooter({ text: notice });

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('admin', 'actedit', activity.name), '編集', { emoji: '✏️', style: ButtonStyle.Primary }),
        button(id('admin', 'actproof', activity.name), activity.need_proof ? '写真必須をやめる' : '写真必須にする', { emoji: '📷' }),
        button(id('admin', 'actdel', activity.name), '削除', { emoji: '🗑️', style: ButtonStyle.Danger }),
      ),
      row(backButton('admin', '管理メニュー'), button(id('admin', 'acts'), 'アクション一覧', { emoji: '📋' }), homeButton()),
    ],
  });
}

function activityModal(customId, title, activity = null) {
  const field = (fieldId, label, { placeholder, value, max = 12, required = false } = {}) => {
    const input = new TextInputBuilder()
      .setCustomId(fieldId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(max);
    if (placeholder) input.setPlaceholder(placeholder);
    if (value) input.setValue(value);
    return new ActionRowBuilder().addComponents(input);
  };

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      field('name', 'アクション名', { placeholder: '例: 筋トレ', value: activity?.name, max: 32, required: true }),
      field('reward', 'もらえるコイン', { placeholder: '例: 50', value: activity ? String(activity.reward) : '', required: true }),
      field('cooldown', 'クールダウン（分・空欄でなし）', { placeholder: '例: 360', value: activity && activity.cooldown_sec > 0 ? String(Math.round(activity.cooldown_sec / 60)) : '' }),
      field('daily', '1日の上限回数（空欄で無制限）', { placeholder: '例: 2', value: activity && activity.daily_limit > 0 ? String(activity.daily_limit) : '' }),
      field('emoji', '絵文字（任意）', { placeholder: '例: 💪', value: activity?.emoji ?? '', max: 8 }),
    );
}

export async function actnew(interaction) {
  if (!(await guard(interaction))) return undefined;
  return interaction.showModal(activityModal(id('admin', 'actsave'), 'アクションを追加'));
}

export async function actedit(interaction, args) {
  if (!(await guard(interaction))) return undefined;
  const name = args.join(':');
  const activity = getActivity(interaction.guildId, name);
  if (!activity) return toast(interaction, 'そのアクションは見つかりませんでした。');
  return interaction.showModal(activityModal(id('admin', 'actsave2', activity.name), `${activity.name} を編集`, activity));
}

export async function actsave(interaction) {
  return saveActivity(interaction, null);
}

export async function actsave2(interaction, args) {
  return saveActivity(interaction, args.join(':'));
}

async function saveActivity(interaction, previousName) {
  if (!(await guard(interaction))) return undefined;
  const name = readText(interaction, 'name');
  const reward = readInt(interaction, 'reward', { min: 0 });
  const cooldown = readInt(interaction, 'cooldown', { min: 0, fallback: 0 });
  const daily = readInt(interaction, 'daily', { min: 0, fallback: 0 });

  if (!name) return toast(interaction, 'アクション名を入力してください。');
  if (isError(reward)) return toast(interaction, reward.error);
  if (isError(cooldown)) return toast(interaction, cooldown.error);
  if (isError(daily)) return toast(interaction, daily.error);

  const previous = previousName ? getActivity(interaction.guildId, previousName) : null;
  upsertActivity(interaction.guildId, {
    name,
    reward,
    cooldown_sec: cooldown * 60,
    daily_limit: daily,
    emoji: readText(interaction, 'emoji'),
    need_proof: previous?.need_proof ?? 0,
    description: previous?.description ?? null,
  });
  // 名前を変えた場合は古い方を消す（報告履歴は旧名のまま残る）
  if (previous && previous.name !== name) removeActivity(interaction.guildId, previous.name);

  return actview(interaction, [name], previous ? '更新しました' : '追加しました');
}

export async function actproof(interaction, args) {
  if (!(await guard(interaction))) return undefined;
  const name = args.join(':');
  const activity = getActivity(interaction.guildId, name);
  if (!activity) return toast(interaction, 'そのアクションは見つかりませんでした。');
  upsertActivity(interaction.guildId, { name, need_proof: activity.need_proof ? 0 : 1 });
  return actview(interaction, [name], activity.need_proof ? '写真を任意にしました' : '写真を必須にしました');
}

export async function actdel(interaction, args) {
  if (!(await guard(interaction))) return undefined;
  const name = args.join(':');
  removeActivity(interaction.guildId, name);
  return acts(interaction, [], `「${name}」を削除しました`);
}

export async function preset(interaction) {
  if (!(await guard(interaction))) return undefined;
  const added = [];
  for (const item of PRESET_ACTIVITIES) {
    if (getActivity(interaction.guildId, item.name)) continue;
    upsertActivity(interaction.guildId, item);
    added.push(item.name);
  }
  return acts(interaction, [], added.length > 0 ? `登録しました: ${added.join('、')}` : 'すべて登録済みです');
}

/* ------------------------------------------------------------------ 残高調整 */

export async function bal(interaction) {
  if (!(await guard(interaction))) return undefined;
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('💰 残高を調整')
    .setDescription('対象のメンバーを選んでください。');
  const select = new UserSelectMenuBuilder().setCustomId(id('admin', 'baluser')).setPlaceholder('メンバーを選ぶ').setMaxValues(1);
  return show(interaction, { embeds: [embed], components: [row(select), row(backButton('admin'), homeButton())] });
}

export async function baluser(interaction) {
  return balview(interaction, [interaction.values[0]]);
}

export async function balview(interaction, [userId], notice = null) {
  if (!(await guard(interaction))) return undefined;
  const settings = getSettings(interaction.guildId);
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('💰 残高を調整')
    .setDescription(`対象: <@${userId}>\n現在の所持金 ${coins(getBalance(interaction.guildId, userId), settings)}`);
  if (notice) embed.setFooter({ text: notice });

  return show(interaction, {
    embeds: [embed],
    components: [
      row(
        button(id('admin', 'balmodal', 'give', userId), '配る', { emoji: '➕', style: ButtonStyle.Success }),
        button(id('admin', 'balmodal', 'take', userId), '回収する', { emoji: '➖', style: ButtonStyle.Danger }),
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

export async function balmodal(interaction, [mode, userId]) {
  if (!(await guard(interaction))) return undefined;
  const modal = new ModalBuilder()
    .setCustomId(id('admin', 'balapply', mode, userId))
    .setTitle(MODE_LABEL[mode] ?? '残高調整')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('amount').setLabel('金額').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('理由（任意）').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ),
    );
  return interaction.showModal(modal);
}

export async function balapply(interaction, [mode, userId]) {
  if (!(await guard(interaction))) return undefined;
  const settings = getSettings(interaction.guildId);
  const amount = readInt(interaction, 'amount', { min: 0 });
  if (isError(amount)) return toast(interaction, amount.error);
  const reason = readText(interaction, 'reason');

  let balance;
  if (mode === 'set') balance = setBalance(interaction.guildId, userId, amount, 'admin:set', reason);
  else balance = adjust(interaction.guildId, userId, mode === 'give' ? amount : -amount, `admin:${mode}`, reason);

  if (mode === 'give' && amount > 0) {
    await announce(interaction, {
      content: `🎁 <@${userId}> に ${coins(amount, settings)} が配られました。${reason ? `\n> ${reason}` : ''}`,
      allowedMentions: { users: [userId] },
    });
  }

  return balview(interaction, [userId], `${MODE_LABEL[mode]}を実行しました（現在 ${balance}）`);
}

export async function balhist(interaction, [userId]) {
  if (!(await guard(interaction))) return undefined;
  const rows = getDb()
    .prepare('SELECT * FROM ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15')
    .all(interaction.guildId, userId);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📜 コインの履歴')
    .setDescription(
      rows.length === 0
        ? 'まだ履歴がありません。'
        : `対象: <@${userId}>\n\n` +
            rows
              .map((r) => {
                const sign = r.amount >= 0 ? '+' : '';
                const detail = r.detail ? `（${truncate(r.detail, 40)}）` : '';
                return `<t:${Math.floor(r.created_at / 1000)}:R>　\`${sign}${r.amount}\`　${r.reason}${detail}`;
              })
              .join('\n'),
    );

  return show(interaction, {
    embeds: [embed],
    components: [row(button(id('admin', 'balview', userId), '戻る', { emoji: '◀️' }), homeButton())],
  });
}

/* ------------------------------------------------------------------ 通貨設定 */

export async function cfg(interaction) {
  if (!(await guard(interaction))) return undefined;
  const settings = getSettings(interaction.guildId);
  const field = (fieldId, label, value, max = 12) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(fieldId)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(max)
        .setValue(String(value)),
    );

  const modal = new ModalBuilder()
    .setCustomId(id('admin', 'cfgsave'))
    .setTitle('通貨の設定')
    .addComponents(
      field('currency_name', '通貨の名前', settings.currency_name, 16),
      field('currency_emoji', '通貨の絵文字', settings.currency_emoji, 8),
      field('starting_balance', '新規メンバーの初期残高', settings.starting_balance),
      field('min_bet', '最低賭け金', settings.min_bet),
      field('max_bet', '最高賭け金（0で無制限）', settings.max_bet),
    );
  return interaction.showModal(modal);
}

export async function cfgsave(interaction) {
  if (!(await guard(interaction))) return undefined;
  const starting = readInt(interaction, 'starting_balance', { min: 0 });
  const minBet = readInt(interaction, 'min_bet', { min: 1 });
  const maxBet = readInt(interaction, 'max_bet', { min: 0 });
  for (const value of [starting, minBet, maxBet]) {
    if (isError(value)) return toast(interaction, value.error);
  }
  if (maxBet !== null && minBet !== null && maxBet > 0 && maxBet < minBet) {
    return toast(interaction, '最高賭け金は最低賭け金以上にしてください。');
  }

  updateSettings(interaction.guildId, {
    currency_name: readText(interaction, 'currency_name'),
    currency_emoji: readText(interaction, 'currency_emoji'),
    starting_balance: starting,
    min_bet: minBet,
    max_bet: maxBet,
  });
  return open(interaction);
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
  actproof,
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
