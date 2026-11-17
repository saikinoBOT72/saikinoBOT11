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
import * as omikuji from './omikuji.js';
import * as profile from './profile.js';
import { MENU_PREFIX } from './common.js';
import { deferUpdate } from '../discord/respond.js';
import { gated, gatedAll } from './games.js';
import { foldRules, withCrumb } from './rules-fold.js';

/**
 * 画面名 → 操作名 → ハンドラ。customId は `m:<画面>:<操作>:<引数...>`。
 *
 * ゲームの入口は gated() で包む。管理メニューでオフにされていたら
 * 「あそぶ」に戻す。始まってしまった勝負の画面（doors など）は包まない。
 * 途中でオフにされても、進行中の勝負は最後まで終われるようにするため。
 */
export const screens = {
  home: home.actions,
  report: withCrumb('🏠 › 💪 報告してかせぐ', report.actions),
  games: games.games,
  slot: gated('slot', foldRules('slot', games.slot)),
  cf: gated('cf', foldRules('cf', games.cf)),
  rps: gated('rps', foldRules('rps', games.rps)),
  cc: gated('cc', foldRules('cc', games.cc)),
  shop: withCrumb('🏠 › 🛍️ ショップ', shop.actions),
  wallet: wallet.actions,
  admin: withCrumb('🏠 › ⚙️ 管理', admin.actions),
  privacy: privacy.actions,
  titles: titles.actions,
  profile: profile.actions,
  hl: gated('hl', foldRules('hl', highlow.actions)),
  poll: gated('poll', poll.actions),
  doors: doors.actions,
  lot: gated('lot', lottery.actions),
  omi: gatedAll('omi', omikuji.actions),
  bj: gated('bj', foldRules('bj', games.bj)),
  pk: gated('pk', foldRules('pk', games.pk)),
  pig: gated('pig', foldRules('pig', games.pig)),
  ch: gated('ch', foldRules('ch', games.ch)),
  yt: gated('yt', foldRules('yt', games.yt)),
  rr: gated('rr', foldRules('rr', games.rr)),
  cs: gated('cs', foldRules('cs', games.cs)),
  mine: gated('mine', foldRules('mine', games.mine)),
  dd: gated('dd', foldRules('dd', games.dd)),
};

export const namespace = MENU_PREFIX;

export function findHandler(customId) {
  const [prefix, screen, action, ...args] = customId.split(':');
  if (prefix !== MENU_PREFIX) return null;
  const handler = screens[screen]?.[action];
  return handler ? { handler, args } : null;
}

/**
 * 返事の前に Discord へ投稿したり問い合わせたりする、時間のかかる操作。
 *
 * Discord は3秒以内に返事が無いと「応答しませんでした」と出す。投稿先が混んでいると
 * 間に合わないことがあるので、これらは先に「受け取った」とだけ返し、
 * 終わってから画面を書き換える（15分の猶予がある）。
 */
export const SLOW_ACTIONS = new Set([
  'admin:emoji', 'admin:panelch', 'admin:routeto', 'admin:logch', 'admin:prefgame', 'admin:preflive',
  'poll:create',
  'pk:go', 'pk:amount', 'pig:go', 'pig:amount', 'ch:go', 'ch:amount', 'yt:go', 'yt:amount', 'yt:solo',
  'bj:go', 'bj:solo', 'rps:go', 'rps:amount', 'cc:go', 'cc:amount',
  'rr:go', 'rr:amount', 'cs:go', 'cs:amount', 'mine:go', 'mine:amount', 'dd:go', 'dd:amount',
]);

export async function handleComponent(ix, ctx) {
  const found = findHandler(ix.customId);
  if (!found) {
    console.warn(`未知のメニュー操作: ${ix.customId}`);
    return home.open(ix, [], ctx, 'その操作は使えなくなっています。メニューを開き直しました。');
  }

  const [, screen, action] = ix.customId.split(':');
  const canDefer = ix.isComponent || (ix.isModalSubmit && ix.fromMessage);
  if (ctx.deferSlow && canDefer && SLOW_ACTIONS.has(`${screen}:${action}`)) {
    ctx.waitUntil(finishLater(ix, ctx, found));
    return deferUpdate();
  }
  return found.handler(ix, found.args, ctx);
}

/** 先に「受け取った」と返したあと、処理を済ませて画面を書き換える。 */
async function finishLater(ix, ctx, found) {
  const appId = ix.raw.application_id;
  const token = ix.raw.token;
  try {
    const response = await found.handler(ix, found.args, ctx);
    const body = await response.json();
    if (body?.data && (body.type === 4 || body.type === 7)) {
      await ctx.rest.editOriginalResponse(appId, token, body.data);
    }
  } catch (error) {
    await ctx.reportError(ix.guildId, ix.customId.split(':').slice(0, 3).join(':'), error);
    await ctx.rest
      .editOriginalResponse(appId, token, {
        content: '⚠️ 処理中にエラーが起きました。もう一度お試しください。続くようならサーバー管理者に伝えてください。',
        embeds: [],
        components: [],
      })
      .catch((inner) => console.error('エラーの表示に失敗:', inner));
  }
}

export const openHome = home.open;
