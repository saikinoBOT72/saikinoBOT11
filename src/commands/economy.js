import {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { adjust, getBalance, getSettings, setBalance, updateSettings } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import { getDb } from '../lib/db.js';

export const data = new SlashCommandBuilder()
  .setName('economy')
  .setDescription('通貨の管理（管理者用）')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('give')
      .setDescription('コインを配る')
      .addUserOption((o) => o.setName('user').setDescription('相手').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('reason').setDescription('理由（任意）').setMaxLength(100)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('take')
      .setDescription('コインを回収する')
      .addUserOption((o) => o.setName('user').setDescription('相手').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('reason').setDescription('理由（任意）').setMaxLength(100)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('所持金を指定額にする')
      .addUserOption((o) => o.setName('user').setDescription('相手').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('金額').setRequired(true).setMinValue(0)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('通貨の名前や賭け金上限を設定する')
      .addStringOption((o) => o.setName('currency_name').setDescription('通貨の名前（例: コイン）').setMaxLength(16))
      .addStringOption((o) => o.setName('currency_emoji').setDescription('通貨の絵文字').setMaxLength(8))
      .addIntegerOption((o) => o.setName('starting_balance').setDescription('新規メンバーの初期残高').setMinValue(0))
      .addIntegerOption((o) => o.setName('min_bet').setDescription('最低賭け金').setMinValue(1))
      .addIntegerOption((o) => o.setName('max_bet').setDescription('最高賭け金（0で無制限）').setMinValue(0)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription('コインの増減履歴を見る')
      .addUserOption((o) => o.setName('user').setDescription('対象').setRequired(true))
      .addIntegerOption((o) => o.setName('count').setDescription('表示件数（初期値10）').setMinValue(1).setMaxValue(25)),
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const settings = getSettings(interaction.guildId);

  if (sub === 'config') {
    const patch = {
      currency_name: interaction.options.getString('currency_name'),
      currency_emoji: interaction.options.getString('currency_emoji'),
      starting_balance: interaction.options.getInteger('starting_balance'),
      min_bet: interaction.options.getInteger('min_bet'),
      max_bet: interaction.options.getInteger('max_bet'),
    };
    const updated = updateSettings(interaction.guildId, patch);
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('⚙️ 通貨設定')
      .setDescription(
        [
          `通貨: ${updated.currency_emoji} ${updated.currency_name}`,
          `初期残高: ${updated.starting_balance}`,
          `賭け金: ${updated.min_bet} 〜 ${updated.max_bet === 0 ? '無制限' : updated.max_bet}`,
        ].join('\n'),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'history') {
    const target = interaction.options.getUser('user');
    const limit = interaction.options.getInteger('count') ?? 10;
    const rows = getDb()
      .prepare('SELECT * FROM ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?')
      .all(interaction.guildId, target.id, limit);
    const body =
      rows.length === 0
        ? '履歴がありません。'
        : rows
            .map((row) => {
              const sign = row.amount >= 0 ? '+' : '';
              const detail = row.detail ? `（${row.detail}）` : '';
              return `<t:${Math.floor(row.created_at / 1000)}:R> \`${sign}${row.amount}\` ${row.reason}${detail}`;
            })
            .join('\n');
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle(`📜 ${target.displayName ?? target.username} の履歴`)
          .setDescription(body),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getUser('user');
  if (target.bot) {
    await interaction.reply({ content: 'Botは対象にできません。', flags: MessageFlags.Ephemeral });
    return;
  }
  const reason = interaction.options.getString('reason') ?? null;

  if (sub === 'set') {
    const amount = interaction.options.getInteger('amount');
    const balance = setBalance(interaction.guildId, target.id, amount, 'admin:set', reason);
    await interaction.reply(`<@${target.id}> の所持金を ${coins(balance, settings)} に設定しました。`);
    return;
  }

  const amount = interaction.options.getInteger('amount');
  const delta = sub === 'give' ? amount : -amount;
  const before = getBalance(interaction.guildId, target.id);
  const balance = adjust(interaction.guildId, target.id, delta, `admin:${sub}`, reason);
  const moved = Math.abs(balance - before);

  await interaction.reply(
    sub === 'give'
      ? `🎁 <@${target.id}> に ${coins(amount, settings)} を配りました。（現在 ${coins(balance, settings)}）`
      : `🧾 <@${target.id}> から ${coins(moved, settings)} を回収しました。（現在 ${coins(balance, settings)}）`,
  );
}
