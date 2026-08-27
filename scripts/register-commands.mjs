// スラッシュコマンドを Discord に登録する。GitHub Actions から実行される。
// 必要な環境変数: DISCORD_TOKEN, DISCORD_APPLICATION_ID, （任意）DISCORD_GUILD_ID
import { COMMAND_DEFINITIONS } from '../src/commands.js';

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!token || !applicationId) {
  console.error('DISCORD_TOKEN と DISCORD_APPLICATION_ID を設定してください。');
  process.exit(1);
}

const path = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;

const response = await fetch(`https://discord.com/api/v10${path}`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(COMMAND_DEFINITIONS),
});

if (!response.ok) {
  console.error(`登録に失敗しました (${response.status}):`, await response.text());
  process.exit(1);
}

const registered = await response.json();
console.log(
  `${registered.length} 件のコマンドを登録しました（${guildId ? `サーバー ${guildId}` : 'グローバル：反映に最大1時間'}）`,
);
for (const command of registered) console.log(` - /${command.name}`);
