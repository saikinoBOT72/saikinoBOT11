import { InteractionContextType } from './discord/constants.js';
import { openHome } from './menu/router.js';
import { help } from './menu/home.js';

/**
 * 登録するスラッシュコマンド。
 * 操作はすべてメニューのボタンで行うので、入口はこの2つだけ。
 */
export const COMMAND_DEFINITIONS = [
  {
    name: 'menu',
    description: 'メニューを開く（報告・ゲーム・ショップ・送金すべてここから）',
    contexts: [InteractionContextType.GUILD],
  },
  {
    name: 'help',
    description: 'このBotの使い方を見る',
    contexts: [InteractionContextType.GUILD],
  },
];

const handlers = {
  menu: (ix, ctx) => openHome(ix, [], ctx),
  help: (ix, ctx) => help(ix, [], ctx),
};

export function findCommand(name) {
  return handlers[name] ?? null;
}
