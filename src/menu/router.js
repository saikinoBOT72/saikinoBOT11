import * as home from './home.js';
import * as report from './report.js';
import * as games from './games.js';
import * as shop from './shop.js';
import * as wallet from './wallet.js';
import * as admin from './admin.js';
import * as privacy from './privacy.js';
import * as titles from './titles.js';
import * as highlow from './highlow.js';
import * as doors from './doors.js';
import * as lottery from './lottery.js';
import * as poll from './poll.js';
import * as fishing from './fishing.js';
import * as omikuji from './omikuji.js';
import { MENU_PREFIX } from './common.js';
import { gated, gatedAll } from './games.js';

/**
 * 画面名 → 操作名 → ハンドラ。customId は `m:<画面>:<操作>:<引数...>`。
 *
 * ゲームの入口は gated() で包む。管理メニューでオフにされていたら
 * 「あそぶ」に戻す。始まってしまった勝負の画面（doors など）は包まない。
 * 途中でオフにされても、進行中の勝負は最後まで終われるようにするため。
 */
export const screens = {
  home: home.actions,
  report: report.actions,
  games: games.games,
  slot: gated('slot', games.slot),
  cf: gated('cf', games.cf),
  rps: gated('rps', games.rps),
  cc: gated('cc', games.cc),
  shop: shop.actions,
  wallet: wallet.actions,
  admin: admin.actions,
  privacy: privacy.actions,
  titles: titles.actions,
  hl: gated('hl', highlow.actions),
  poll: gated('poll', poll.actions),
  doors: doors.actions,
  lot: gated('lot', lottery.actions),
  fish: gatedAll('fish', fishing.actions),
  omi: gatedAll('omi', omikuji.actions),
  bj: gated('bj', games.bj),
  rr: gated('rr', games.rr),
  cs: gated('cs', games.cs),
  mine: gated('mine', games.mine),
  dd: gated('dd', games.dd),
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
