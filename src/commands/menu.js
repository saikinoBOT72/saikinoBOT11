import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { openHome, handleComponent, namespace } from '../menu/router.js';

export const data = new SlashCommandBuilder()
  .setName('menu')
  .setDescription('ボタン操作のメニューを開く（これひとつで全部できます）')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  await openHome(interaction);
}

export { handleComponent, namespace };
