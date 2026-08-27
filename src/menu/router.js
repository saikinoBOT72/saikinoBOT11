import * as home from './home.js';
import * as report from './report.js';
import * as games from './games.js';
import * as shop from './shop.js';
import * as wallet from './wallet.js';
import * as admin from './admin.js';
import { MENU_PREFIX } from './common.js';

/** 画面名 → 操作名 → ハンドラ。customId は `m:<画面>:<操作>:<引数...>`。 */
export const screens = {
  home: home.actions,
  report: report.actions,
  games: games.games,
  slot: games.slot,
  cf: games.cf,
  rps: games.rps,
  shop: shop.actions,
  wallet: wallet.actions,
  admin: admin.actions,
};

export const namespace = MENU_PREFIX;

export async function handleComponent(interaction) {
  const [, screen, action, ...args] = interaction.customId.split(':');
  const handler = screens[screen]?.[action];
  if (!handler) {
    console.warn(`未知のメニュー操作: ${interaction.customId}`);
    return;
  }
  await handler(interaction, args);
}

export const openHome = home.open;
