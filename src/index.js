import { InteractionType } from './discord/constants.js';
import { verifyRequest } from './discord/verify.js';
import { Ix } from './discord/interaction.js';
import { json, pong, reply } from './discord/respond.js';
import { createContext } from './context.js';
import { handleComponent as handleMenu } from './menu/router.js';
import { handleComponent as handleRps } from './menu/rps-challenge.js';
import { handleComponent as handleChinchiro } from './menu/chinchiro-match.js';
import { handleComponent as handlePoll } from './menu/poll-board.js';
import { handleComponent as handleDuel } from './menu/duel-board.js';
import { handleComponent as handleBlackjack } from './menu/blackjack-table.js';
import { handleComponent as handleReportPanel } from './menu/report-panel.js';
import { findCommand } from './commands.js';
import { runScheduled } from './cron.js';
import { handleFishingApi } from './game/api.js';

const FISHING_API = '/api/fishing/';

export default {
  /** Discord からの Interaction を受け取る入口。 */
  async fetch(request, env, executionCtx) {
    // 釣りゲームからの呼び出し。Discord の署名確認より先に振り分ける。
    const url = new URL(request.url);
    if (url.pathname.startsWith(FISHING_API)) {
      return handleFishingApi(request, url.pathname.slice(FISHING_API.length), createContext(env, executionCtx, url.origin));
    }

    if (request.method === 'GET') {
      return new Response('saikinoBOT11 は動いています。', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const { valid, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('署名を確認できませんでした。', { status: 401 });

    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Discord からの疎通確認
    if (raw.type === InteractionType.PING) return pong();

    const ix = new Ix(raw);
    const ctx = createContext(env, executionCtx, url.origin);

    try {
      return await dispatch(ix, ctx);
    } catch (error) {
      console.error('処理中のエラー:', error);
      return reply({ content: '処理中にエラーが発生しました。もう一度お試しください。' });
    }
  },

  /** 1分ごとに走る。中身は cron.js。 */
  async scheduled(_event, env, executionCtx) {
    await runScheduled(createContext(env, executionCtx));
  },
};

async function dispatch(ix, ctx) {
  if (!ix.guildId) return reply({ content: 'このBotはサーバー内でのみ使えます。' });

  if (ix.type === InteractionType.APPLICATION_COMMAND) {
    const command = findCommand(ix.commandName);
    if (!command) return reply({ content: '知らないコマンドです。' });
    return command(ix, ctx);
  }

  if (ix.type === InteractionType.MESSAGE_COMPONENT || ix.type === InteractionType.MODAL_SUBMIT) {
    const [namespace] = ix.customId.split(':');
    if (namespace === 'm') return handleMenu(ix, ctx);
    if (namespace === 'rps') return handleRps(ix, ctx);
    if (namespace === 'cc') return handleChinchiro(ix, ctx);
    if (namespace === 'pl') return handlePoll(ix, ctx);
    if (namespace === 'd') return handleDuel(ix, ctx);
    if (namespace === 'bj') return handleBlackjack(ix, ctx);
    if (namespace === 'rp') return handleReportPanel(ix, ctx);
    return reply({ content: 'この操作はもう使えません。`/menu` を開き直してください。' });
  }

  return json({ type: 1 });
}
