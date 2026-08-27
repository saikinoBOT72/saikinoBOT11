import { REST, Routes } from 'discord.js';
import { assertConfig, config } from './config.js';
import { loadCommands } from './lib/loader.js';

try {
  assertConfig();
} catch (error) {
  console.error(`起動できません: ${error.message}`);
  process.exit(1);
}

const { commands } = await loadCommands();
const body = [...commands.values()].map((command) => command.data.toJSON());
const rest = new REST().setToken(config.token);

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

const result = await rest.put(route, { body });
console.log(
  `${result.length} 件のコマンドを登録しました（${config.guildId ? `サーバー ${config.guildId}` : 'グローバル：反映に最大1時間'}）`,
);
for (const command of result) console.log(` - /${command.name}`);
