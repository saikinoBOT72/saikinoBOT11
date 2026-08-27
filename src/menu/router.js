import * as home from './home.js';
import * as report from './report.js';
import * as games from './games.js';
import * as shop from './shop.js';
import * as wallet from './wallet.js';
import * as admin from './admin.js';
import * as privacy from './privacy.js';
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
  privacy: privacy.actions,
};

export const namespace = MENU_PREFIX;

export function findHandler(customId) {
  const [prefix, screen, action, ...args] = customId.split(':');
  if (prefix !== MENU_PREFIX) return null;
  const handler = screens[screen]?.[action];
  return handler ? { handler, args } : null;
}

export async function handleComponent(ix, ctx) {
  const found = findHandler(ix.customId);
  if (!found) {
    console.warn(`未知のメニュー操作: ${ix.customId}`);
    return home.open(ix, [], ctx, 'その操作は使えなくなっています。メニューを開き直しました。');
  }
  return found.handler(ix, found.args, ctx);
}

export const openHome = home.open;
