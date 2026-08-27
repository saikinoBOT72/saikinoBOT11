import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commandsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');

/**
 * src/commands/*.js を読み込む。
 * 各モジュールは data（SlashCommandBuilder）と execute を持ち、
 * 任意で autocomplete / namespace + handleComponent を公開する。
 */
export async function loadCommands() {
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js')).sort();
  const commands = new Map();
  const components = new Map();

  for (const file of files) {
    const module = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (!module.data || typeof module.execute !== 'function') {
      throw new Error(`${file} は data と execute を export する必要があります`);
    }
    commands.set(module.data.name, module);
    if (module.namespace && typeof module.handleComponent === 'function') {
      components.set(module.namespace, module);
    }
  }

  return { commands, components };
}
