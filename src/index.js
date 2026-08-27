import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { assertConfig, config } from './config.js';
import { closeDb, getDb } from './lib/db.js';
import { loadCommands } from './lib/loader.js';
import { refundStaleMatches } from './lib/rps.js';

try {
  assertConfig();
} catch (error) {
  console.error(`起動できません: ${error.message}`);
  process.exit(1);
}
getDb();

const { commands, components } = await loadCommands();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (ready) => {
  const refunded = refundStaleMatches();
  console.log(`ログインしました: ${ready.user.tag}（コマンド ${commands.size} 件）`);
  if (refunded > 0) console.log(`未決着のじゃんけん ${refunded} 件を返金・中止しました`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }

    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'このBotはサーバー内でのみ使えます。', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const [namespace] = interaction.customId.split(':');
      const handler = components.get(namespace);
      if (handler) await handler.handleComponent(interaction);
    }
  } catch (error) {
    console.error('インタラクション処理でエラー:', error);
    await replyError(interaction);
  }
});

async function replyError(interaction) {
  if (!interaction.isRepliable()) return;
  const payload = { content: '処理中にエラーが発生しました。しばらくしてからもう一度お試しください。', flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (error) {
    console.error('エラー通知に失敗:', error);
  }
}

client.on(Events.Error, (error) => console.error('クライアントエラー:', error));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} を受け取りました。終了します。`);
    client.destroy();
    closeDb();
    process.exit(0);
  });
}

await client.login(config.token);
