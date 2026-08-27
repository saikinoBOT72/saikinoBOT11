import {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  PRESET_ACTIVITIES,
  getActivity,
  listActivities,
  removeActivity,
  upsertActivity,
} from '../lib/activities.js';
import { duration } from '../lib/format.js';

export const data = new SlashCommandBuilder()
  .setName('activity')
  .setDescription('報告アクションの管理（管理者用）')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('アクションを追加・更新する')
      .addStringOption((o) => o.setName('name').setDescription('アクション名（例: 筋トレ）').setRequired(true).setMaxLength(32))
      .addIntegerOption((o) => o.setName('reward').setDescription('もらえるコイン').setRequired(true).setMinValue(0))
      .addStringOption((o) => o.setName('emoji').setDescription('絵文字（任意）').setMaxLength(8))
      .addIntegerOption((o) =>
        o.setName('cooldown_minutes').setDescription('連続報告を防ぐクールダウン（分・0で無制限）').setMinValue(0),
      )
      .addIntegerOption((o) => o.setName('daily_limit').setDescription('1日の報告上限（0で無制限）').setMinValue(0))
      .addBooleanOption((o) => o.setName('need_proof').setDescription('画像の添付を必須にする'))
      .addStringOption((o) => o.setName('description').setDescription('説明（任意）').setMaxLength(200)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('アクションを削除する')
      .addStringOption((o) => o.setName('name').setDescription('アクション名').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('登録済みアクションを設定つきで一覧表示する'))
  .addSubcommand((sub) => sub.setName('preset').setDescription('おすすめのアクション一式（筋トレなど）を登録する'));

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = listActivities(interaction.guildId)
    .filter((a) => a.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((a) => ({ name: a.name, value: a.name }));
  await interaction.respond(choices);
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleAdd(interaction);
  if (sub === 'remove') return handleRemove(interaction);
  if (sub === 'preset') return handlePreset(interaction);
  return handleList(interaction);
}

async function handleAdd(interaction) {
  const name = interaction.options.getString('name').trim();
  const cooldownMinutes = interaction.options.getInteger('cooldown_minutes');
  const existed = Boolean(getActivity(interaction.guildId, name));

  const activity = upsertActivity(interaction.guildId, {
    name,
    reward: interaction.options.getInteger('reward'),
    emoji: interaction.options.getString('emoji'),
    cooldown_sec: cooldownMinutes === null ? null : cooldownMinutes * 60,
    daily_limit: interaction.options.getInteger('daily_limit'),
    need_proof: interaction.options.getBoolean('need_proof') === null ? null : (interaction.options.getBoolean('need_proof') ? 1 : 0),
    description: interaction.options.getString('description'),
  });

  await interaction.reply({
    content: `${existed ? '更新' : '追加'}しました: ${describe(activity)}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemove(interaction) {
  const name = interaction.options.getString('name');
  const removed = removeActivity(interaction.guildId, name);
  await interaction.reply({
    content: removed ? `「${name}」を削除しました。` : `「${name}」は登録されていません。`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePreset(interaction) {
  const added = [];
  for (const preset of PRESET_ACTIVITIES) {
    if (getActivity(interaction.guildId, preset.name)) continue;
    upsertActivity(interaction.guildId, preset);
    added.push(preset.name);
  }
  await interaction.reply({
    content:
      added.length > 0
        ? `プリセットを登録しました: ${added.join('、')}\n報酬やクールダウンは \`/activity add\` で同じ名前を指定すれば上書きできます。`
        : 'プリセットのアクションはすべて登録済みです。',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction) {
  const activities = listActivities(interaction.guildId);
  if (activities.length === 0) {
    await interaction.reply({ content: 'まだ登録がありません。`/activity preset` が手軽です。', flags: MessageFlags.Ephemeral });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ 登録済みアクション')
    .setDescription(activities.map(describe).join('\n'));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function describe(a) {
  const bits = [`報酬 ${a.reward}`];
  bits.push(a.cooldown_sec > 0 ? `CD ${duration(a.cooldown_sec)}` : 'CDなし');
  bits.push(a.daily_limit > 0 ? `1日${a.daily_limit}回` : '回数無制限');
  if (a.need_proof) bits.push('画像必須');
  return `${a.emoji ?? '•'} **${a.name}** — ${bits.join(' / ')}`;
}
