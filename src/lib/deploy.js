import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';

/** 登録済みコマンドの内容を覚えておくファイル（data/ に置く）。 */
function markerPath() {
  return path.join(path.dirname(config.databasePath), 'commands.hash');
}

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify({ body, guildId: config.guildId })).digest('hex');
}

/**
 * スラッシュコマンドを Discord に登録する。
 * @param {Map<string, {data: {toJSON: () => object}}>} commands
 * @param {{force?: boolean}} options force: 内容が変わっていなくても登録し直す
 * @returns {Promise<{registered: number, skipped: boolean}>}
 */
export async function syncCommands(commands, { force = false } = {}) {
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const hash = fingerprint(body);
  const marker = markerPath();

  if (!force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === hash) {
    return { registered: body.length, skipped: true };
  }

  const rest = new REST().setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  const result = await rest.put(route, { body });
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, hash);
  return { registered: result.length, skipped: false };
}
