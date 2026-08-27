import { assertConfig, config } from './config.js';
import { loadCommands } from './lib/loader.js';
import { syncCommands } from './lib/deploy.js';

try {
  assertConfig();
} catch (error) {
  console.error(`起動できません: ${error.message}`);
  process.exit(1);
}

const { commands } = await loadCommands();
const result = await syncCommands(commands, { force: true });

console.log(
  `${result.registered} 件のコマンドを登録しました（${config.guildId ? `サーバー ${config.guildId}` : 'グローバル：反映に最大1時間'}）`,
);
for (const command of commands.keys()) console.log(` - /${command}`);
