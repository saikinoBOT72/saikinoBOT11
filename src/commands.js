import { CommandType, InteractionContextType } from './discord/constants.js';
import { openHome } from './menu/router.js';
import { help } from './menu/home.js';
import { showProfile } from './menu/profile.js';
import { payToTarget } from './menu/wallet.js';

/** メンバーを右クリック（スマホは長押し）→「アプリ」に出る項目の名前。 */
export const PROFILE_COMMAND = 'プロフィールを見る';
export const PAY_COMMAND = 'コインを送る';

/**
 * 登録するコマンド。
 * 操作はすべてメニューのボタンで行うので、スラッシュコマンドは /menu と /help だけ。
 * ほかに、メンバーを右クリックしたときの「アプリ」から、その人のプロフィールと送金を開ける。
 * （右クリックの項目には説明文を付けられない決まり）
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
  { name: PROFILE_COMMAND, type: CommandType.USER, contexts: [InteractionContextType.GUILD] },
  { name: PAY_COMMAND, type: CommandType.USER, contexts: [InteractionContextType.GUILD] },
];

const handlers = {
  menu: (ix, ctx) => openHome(ix, [], ctx),
  help: (ix, ctx) => help(ix, [], ctx),
  [PROFILE_COMMAND]: (ix, ctx) => showProfile(ix, ctx, ix.targetId),
  [PAY_COMMAND]: (ix, ctx) => payToTarget(ix, ctx, ix.targetUser),
};

export function findCommand(name) {
  return handlers[name] ?? null;
}
