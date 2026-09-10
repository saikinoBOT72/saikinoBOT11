import { deposit, getBalance, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { payoutTable, spin } from '../lib/slot.js';
import { startChallenge } from './rps-challenge.js';
import { startChallenge as startDuel, findGame } from './duel-board.js';
import { openTable as openBlackjack } from './blackjack-table.js';
import { MAX_PLAYERS as BJ_MAX_PLAYERS } from '../lib/blackjack.js';
import { enabledGames, GAME_BY_KEY, isGameEnabled } from '../lib/game-catalog.js';
import { startChallenge as startChinchiro } from './chinchiro-match.js';
import { escrowFor } from '../lib/chinchiro.js';
import { MAX_MULTIPLIER as DICE_MAX } from '../lib/dice.js';
import { modal, textInput, userSelect } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import {
  amountRows,
  backButton,
  button,
  embed,
  homeButton,
  id,
  isError,
  moneyFields,
  openModal,
  readInt,
  resultEmbed,
  row,
  show,
  withNotice,
} from './common.js';
import { EMOJI as em } from '../lib/emoji.js';

/* ------------------------------------------------------------------ ゲーム選択 */

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const playable = enabledGames(settings);

  if (playable.length === 0) {
    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: 0xe67e22,
            title: '🎮 あそぶ',
            description: 'いま遊べるゲームがありません。\nサーバー管理者が **⚙️ 管理 → 🎮 ゲームのオンオフ** で開けられます。',
          }),
          notice,
        ),
      ],
      components: [row(backButton())],
    });
  }

  // ボタンは1行5個まで。名簿の順に詰めていく
  const rows = [];
  for (let index = 0; index < playable.length; index += 5) {
    rows.push(
      row(
        ...playable.slice(index, index + 5).map((game) =>
          button(id(game.key, 'open'), game.name, {
            emoji: game.emoji,
            style: game.style === 'PRIMARY' ? ButtonStyle.PRIMARY : ButtonStyle.SUCCESS,
          }),
        ),
      ),
    );
  }

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🎮 あそぶ',
          description: `所持金 ${coins(balance, settings)}\n\n遊びたいものを選んでください。`,
          fields: playable.map((game) => ({
            name: `${game.emoji} ${game.name}`,
            value: game.hint,
            inline: true,
          })),
        }),
        notice,
      ),
    ],
    components: [...rows, row(backButton())],
  });
}

/**
 * オフにされたゲームには入れない。
 * ボタンを消しても、前に貼られたメッセージのボタンは残るので入口でも見る。
 */
export function gate(key, handler) {
  return async (ix, args, ctx) => {
    const settings = await ctx.settings(ix.guildId);
    if (!isGameEnabled(settings, key)) {
      const game = GAME_BY_KEY.get(key);
      return open(ix, [], ctx, `${game?.name ?? 'そのゲーム'}はいま遊べません。`);
    }
    return handler(ix, args, ctx);
  };
}

/**
 * 入口（open）だけ見張る。
 * 中の操作まで止めると、賭けている途中でオフにされた人が降りられなくなる
 * （ハイ&ロー・予想大会・宝くじなど）。始めた勝負は終われるようにしておく。
 */
export function gated(key, actions) {
  return actions.open ? { ...actions, open: gate(key, actions.open) } : actions;
}

/**
 * 画面まるごと見張る。
 * 釣りのように、中の操作でもコインが動く（餌や竿を買う・魚を売る）のに、
 * 賭けの途中という状態が無いものに使う。古いメッセージのボタンからも入れない。
 */
export function gatedAll(key, actions) {
  return Object.fromEntries(Object.entries(actions).map(([name, fn]) => [name, gate(key, fn)]));
}

export const games = { open };

/* ------------------------------------------------------------------ 共通 */

function amountModal(customId, title, label = '賭け金') {
  return modal(customId, title, [
    textInput('amount', label, { placeholder: '例: 250', required: true, max: 12 }),
  ]);
}

/* ------------------------------------------------------------------ スロット */

async function slotOpen(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🎰 スロット',
          description: `所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。`,
          fields: [{ name: '配当', value: payoutTable(), inline: true }],
          footer: { text: '3つ揃いのほか、🔔以上は2つ揃いでも配当があります' },
        }),
        notice,
      ),
    ],
    components: amountRows(['slot', 'bet'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
  });
}

function slotCustom() {
  return openModal(amountModal(id('slot', 'amount'), 'スロット'));
}

async function slotAmount(ix, _args, ctx) {
  const amount = readInt(ix, 'amount', { min: 1 });
  if (isError(amount)) return slotOpen(ix, [], ctx, amount.error);
  return slotSpin(ix, ctx, amount);
}

async function slotBet(ix, [amount], ctx) {
  return slotSpin(ix, ctx, Number(amount));
}

async function slotSpin(ix, ctx, bet) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return slotOpen(ix, [], ctx, check.message);

  if (!(await withdraw(ctx.db, ix.guildId, ix.userId, bet, 'slot:bet'))) {
    return slotOpen(ix, [], ctx, '残高が足りません。');
  }

  // 先にお金の処理を済ませてから、演出だけ後追いで見せる
  const result = spin();
  const payout = result.multiplier * bet;
  if (payout > 0) await deposit(ctx.db, ix.guildId, ix.userId, payout, 'slot:win', `x${result.multiplier}`);
  const after = await getBalance(ctx.db, ix.guildId, ix.userId);
  const net = payout - bet;

  // リールは content に絵文字だけで置く。Discord がいちばん大きく描いてくれる。
  const reelLine = (reels) => reels.join('');
  const spinning = (reels, note) => ({
    content: reelLine(reels),
    embeds: [
      embed({
        color: 0xe67e22,
        title: note,
        footer: { text: `賭け金 ${bet.toLocaleString('ja-JP')}` },
      }),
    ],
  });

  const final = resultEmbed({
    art: reelLine(result.reels),
    verdict: slotVerdict(result),
    color: payout > 0 ? 0x2ecc71 : 0x95a5a6,
    detail: slotDetail(result, payout, settings),
    fields: moneyFields(bet, net, after, settings, { coins }),
  });
  const finalComponents = [
    row(
      button(id('slot', 'bet', String(bet)), `もう一度（${bet}）`, {
        emoji: '🔁',
        style: ButtonStyle.SUCCESS,
        disabled: after < bet,
      }),
      button(id('slot', 'open'), '賭け金を変える', { emoji: '💰' }),
      homeButton(),
    ),
  ];

  // 左のリールから1つずつ止まっていく
  ctx.animate(ix, [
    { after: 800, payload: { ...spinning([result.reels[0], em.slot_spin, em.slot_spin], '🎰 回転中…'), components: [] } },
    { after: 800, payload: { ...spinning([result.reels[0], result.reels[1], em.slot_spin], '🎰 回転中…'), components: [] } },
    { after: 800, payload: { ...final, components: finalComponents } },
  ]);

  if (result.kind === 'triple') {
    ctx.announce(ix.channelId, {
      embeds: [
        embed({
          color: 0xf1c40f,
          title: '🎉 大当たり！',
          description: `<@${ix.userId}> がスロットで **${result.symbol} 3つ揃い（x${result.multiplier}）**！\n${coins(payout, settings)} を獲得しました。`,
        }),
      ],
    });
  }

  return show(ix, { ...spinning([em.slot_spin, em.slot_spin, em.slot_spin], '🎰 回転中…'), components: [] });
}

/** 結果のひとこと。いちばん先に読ませたいので短く。 */
function slotVerdict(result) {
  if (result.kind === 'triple') return `🎉 3つそろい！ ×${result.multiplier}`;
  if (result.kind === 'double') return `✨ 2つそろい ×${result.multiplier}`;
  return '💧 はずれ';
}

function slotDetail(result, payout, settings) {
  // 揃わなかったときの kind は 'lose'（'none' ではない）
  if (result.kind === 'lose') return 'そろいませんでした。もう一度どうぞ。';
  return `${result.symbol} がそろって ${coins(payout, settings)} 獲得。`;
}

export const slot = { open: slotOpen, bet: slotBet, custom: slotCustom, amount: slotAmount };

/* ------------------------------------------------------------------ コイントス */

const SIDES = { heads: { label: '表', emoji: em.coin_heads }, tails: { label: '裏', emoji: em.coin_tails } };

async function cfOpen(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf1c40f,
          title: `${em.coinflip} コイントス`,
          description: `所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。当たれば2倍、外れれば没収です。`,
        }),
        notice,
      ),
    ],
    components: amountRows(['cf', 'bet'], balance, { maxBet: settings.max_bet, extra: [backButton('games')] }),
  });
}

function cfCustom() {
  return openModal(amountModal(id('cf', 'amount'), 'コイントス'));
}

async function cfAmount(ix, _args, ctx) {
  const amount = readInt(ix, 'amount', { min: 1 });
  if (isError(amount)) return cfOpen(ix, [], ctx, amount.error);
  return cfSide(ix, ctx, amount);
}

async function cfBet(ix, [amount], ctx) {
  return cfSide(ix, ctx, Number(amount));
}

async function cfSide(ix, ctx, bet) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return cfOpen(ix, [], ctx, check.message);

  return show(ix, {
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${em.coinflip} コイントス`,
        description: `賭け金は ${coins(bet, settings)}。\n**表か裏かを選んでください。**`,
      }),
    ],
    components: [
      row(
        button(id('cf', 'go', String(bet), 'heads'), '表', { emoji: em.coin_heads, style: ButtonStyle.PRIMARY }),
        button(id('cf', 'go', String(bet), 'tails'), '裏', { emoji: em.coin_tails, style: ButtonStyle.PRIMARY }),
      ),
      row(backButton('cf', '賭け金を変える'), homeButton()),
    ],
  });
}

async function cfGo(ix, [rawBet, side], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(bet, balance, settings);
  if (!check.ok) return cfOpen(ix, [], ctx, check.message);

  if (!(await withdraw(ctx.db, ix.guildId, ix.userId, bet, 'coinflip:bet'))) {
    return cfOpen(ix, [], ctx, '残高が足りません。');
  }

  const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = outcome === side;
  if (won) await deposit(ctx.db, ix.guildId, ix.userId, bet * 2, 'coinflip:win');
  const after = await getBalance(ctx.db, ix.guildId, ix.userId);

  // コインは content に絵文字だけで置く。ここがいちばん大きく出る。
  const tossing = (note) => ({
    content: em.coinflip,
    embeds: [
      embed({
        color: 0xf1c40f,
        title: note,
        footer: { text: `${SIDES[side].label} に ${bet.toLocaleString('ja-JP')}` },
      }),
    ],
  });

  ctx.animate(ix, [
    { after: 700, payload: { ...tossing('くるくる…'), components: [] } },
    {
      after: 900,
      payload: {
        ...resultEmbed({
          art: SIDES[outcome].emoji,
          verdict: won ? `🎉 ${SIDES[outcome].label} — 的中！` : `💧 ${SIDES[outcome].label} — はずれ`,
          color: won ? 0x2ecc71 : 0x95a5a6,
          detail: won
            ? `${SIDES[side].label} に賭けて当たりました。`
            : `${SIDES[side].label} に賭けていました。`,
          fields: moneyFields(bet, won ? bet : -bet, after, settings, { coins }),
        }),
        components: [
          row(
            button(id('cf', 'go', String(bet), side), `もう一度（${SIDES[side].label} ${bet}）`, {
              emoji: '🔁',
              style: ButtonStyle.SUCCESS,
              disabled: after < bet,
            }),
            button(id('cf', 'open'), '賭け金を変える', { emoji: '💰' }),
            homeButton(),
          ),
        ],
      },
    },
  ]);

  return show(ix, { ...tossing('コインを弾きました…'), components: [] });
}

export const cf = { open: cfOpen, bet: cfBet, custom: cfCustom, amount: cfAmount, go: cfGo };

/* ------------------------------------------------------------------ じゃんけん */

async function rpsOpen(ix, _args, _ctx, notice = null) {
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x5865f2,
          title: '✊✌️🖐️ じゃんけん',
          description: '対戦したい相手を選んでください。\n相手が承諾すると勝負開始です。勝った方が賭け金を総取りします。',
        }),
        notice,
      ),
    ],
    components: [userSelect(id('rps', 'user'), '対戦相手を選ぶ'), row(backButton('games'), homeButton())],
  });
}

async function rpsUser(ix, _args, ctx) {
  const opponentId = ix.values[0];
  if (opponentId === ix.userId) return rpsOpen(ix, [], ctx, '自分自身とは対戦できません。');
  const opponent = ix.raw.data?.resolved?.users?.[opponentId];
  if (opponent?.bot) return rpsOpen(ix, [], ctx, 'Botとは対戦できません。');
  return rpsBetScreen(ix, ctx, opponentId);
}

async function rpsBetScreen(ix, ctx, opponentId, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const rows = amountRows(['rps', 'go', opponentId], balance, { maxBet: settings.max_bet });
  rows[1] = row(
    button(id('rps', 'custom', opponentId), '金額を入力', { emoji: '⌨️' }),
    button(id('rps', 'go', opponentId, '0'), '賭けなし', { emoji: '🤝' }),
    backButton('rps', '相手を選び直す'),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x5865f2,
          title: '✊✌️🖐️ じゃんけん',
          description: `相手: <@${opponentId}>\n所持金 ${coins(balance, settings)}\n\n賭け金を選んでください。`,
        }),
        notice,
      ),
    ],
    components: rows,
  });
}

function rpsCustom(ix, [opponentId]) {
  return openModal(amountModal(id('rps', 'amount', opponentId), 'じゃんけんの賭け金'));
}

async function rpsAmount(ix, [opponentId], ctx) {
  const amount = readInt(ix, 'amount', { min: 0 });
  if (isError(amount)) return rpsBetScreen(ix, ctx, opponentId, amount.error);
  return rpsGo(ix, [opponentId, String(amount)], ctx);
}

async function rpsGo(ix, [opponentId, rawBet], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);

  if (bet > 0) {
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    const check = checkBet(bet, balance, settings);
    if (!check.ok) return rpsBetScreen(ix, ctx, opponentId, check.message);
  }

  const sent = await startChallenge(ctx, {
    guildId: ix.guildId,
    channelId: ix.channelId,
    challengerId: ix.userId,
    opponentId,
    bet,
    settings,
  });
  if (!sent) return rpsBetScreen(ix, ctx, opponentId, 'このチャンネルに挑戦状を送れませんでした。');

  return show(ix, {
    embeds: [
      embed({
        color: 0x5865f2,
        title: '✊ 挑戦状を送りました',
        description:
          `<@${opponentId}> に勝負を申し込みました。\n` +
          (bet > 0 ? `賭け金 ${coins(bet, settings)}\n` : '') +
          'チャンネルのメッセージで、相手が「受けて立つ」を押すと勝負開始です。',
      }),
    ],
    components: [row(button(id('rps', 'open'), 'もう一度挑戦', { emoji: '🔁' }), homeButton())],
  });
}

export const rps = { open: rpsOpen, user: rpsUser, custom: rpsCustom, amount: rpsAmount, go: rpsGo };

/* ------------------------------------------------------------------ チンチロ */

async function ccOpen(ix, _args, _ctx, notice = null) {
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🎲 チンチロ',
          description:
            '対戦したい相手を選んでください。相手が承諾すると勝負開始です。\n\n' +
            'サイコロ3つを振り合い、**役の格で勝敗と倍率**が決まります。\n' +
            `動く可能性のある最大額（賭け金×${DICE_MAX}）を先に預かり、終わったら余りを返します。`,
          fields: [
            {
              name: '役と倍率',
              value: [
                '🌟 ピンゾロ（1・1・1） **×5**',
                '✨ ゾロ目 **×3**',
                '🔥 シゴロ（4・5・6） **×2**',
                '🎲 出目（大きい方が勝ち） **×1**',
                '💀 ヒフミ（1・2・3）を出したら負けて **×2払い**',
              ].join('\n'),
            },
          ],
        }),
        notice,
      ),
    ],
    components: [userSelect(id('cc', 'user'), '対戦相手を選ぶ'), row(backButton('games'), homeButton())],
  });
}

async function ccUser(ix, _args, ctx) {
  const opponentId = ix.values[0];
  if (opponentId === ix.userId) return ccOpen(ix, [], ctx, '自分自身とは対戦できません。');
  const opponent = ix.raw.data?.resolved?.users?.[opponentId];
  if (opponent?.bot) return ccOpen(ix, [], ctx, 'Botとは対戦できません。');
  return ccBetScreen(ix, ctx, opponentId);
}

async function ccBetScreen(ix, ctx, opponentId, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  // 預かる額が持ち金を超える賭け金は選べないようにする
  const affordable = Math.floor(balance / DICE_MAX);
  const rows = amountRows(['cc', 'go', opponentId], affordable, {
    maxBet: settings.max_bet,
    customId: id('cc', 'custom', opponentId),
  });
  rows[1] = row(
    button(id('cc', 'custom', opponentId), '金額を入力', { emoji: '⌨️' }),
    backButton('cc', '相手を選び直す'),
  );

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🎲 チンチロ',
          description:
            `相手: <@${opponentId}>\n所持金 ${coins(balance, settings)}\n\n` +
            `賭け金を選んでください。**その${DICE_MAX}倍を一時的に預かります**（余りは勝負後に返却）。\n` +
            `いまの所持金なら **${affordable.toLocaleString('ja-JP')}** まで賭けられます。`,
        }),
        notice,
      ),
    ],
    components: rows,
  });
}

function ccCustom(ix, [opponentId]) {
  return openModal(amountModal(id('cc', 'amount', opponentId), 'チンチロの賭け金'));
}

async function ccAmount(ix, [opponentId], ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return ccBetScreen(ix, ctx, opponentId, value.error);
  return ccGo(ix, [opponentId, String(value)], ctx);
}

async function ccGo(ix, [opponentId, rawBet], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  const check = checkBet(bet, balance, settings);
  if (!check.ok) return ccBetScreen(ix, ctx, opponentId, check.message);
  if (balance < escrowFor(bet)) {
    return ccBetScreen(
      ix,
      ctx,
      opponentId,
      `この賭け金だと ${escrowFor(bet).toLocaleString('ja-JP')} を預ける必要があります（所持金 ${balance.toLocaleString('ja-JP')}）。`,
    );
  }

  const sent = await startChinchiro(ctx, {
    guildId: ix.guildId,
    channelId: ix.channelId,
    challengerId: ix.userId,
    opponentId,
    bet,
    settings,
  });
  if (!sent) return ccBetScreen(ix, ctx, opponentId, 'このチャンネルに挑戦状を送れませんでした。');

  return show(ix, {
    embeds: [
      embed({
        color: 0xe67e22,
        title: '🎲 挑戦状を送りました',
        description:
          `<@${opponentId}> にチンチロを申し込みました。\n` +
          `賭け金 ${coins(bet, settings)}（預かり ${escrowFor(bet).toLocaleString('ja-JP')}）\n` +
          '相手が「受けて立つ」を押すと勝負開始です。',
      }),
    ],
    components: [row(button(id('cc', 'open'), 'もう一度挑戦', { emoji: '🔁' }), homeButton())],
  });
}

export const cc = { open: ccOpen, user: ccUser, custom: ccCustom, amount: ccAmount, go: ccGo };

/* ------------------------------------------------------------------ 1対1の対戦ゲーム（共通） */

/**
 * ロシアンルーレット・チャージ＆シュート・地雷＆陣取り・運命の扉（2人）は
 * 「相手を選ぶ → 賭け金を決める → 挑戦状を送る」までが同じなので、
 * ここでまとめて画面を作る。ルールの説明だけを各ゲームから受け取る。
 */
function duelScreens(gameKey, { screen, lead, extra = null }) {
  const rules = findGame(gameKey);

  async function open(ix, _args, ctx, notice = null) {
    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: rules.color,
            title: `${em[rules.emojiSlot]} ${rules.title}`,
            description: `${lead}\n\n対戦したい相手を選んでください。相手が承諾すると勝負開始です。`,
            fields: rules.inviteFields ? rules.inviteFields() : [],
          }),
          notice,
        ),
      ],
      components: [
        userSelect(id(screen, 'user'), '対戦相手を選ぶ'),
        row(...(extra ? extra() : []), backButton('games'), homeButton()),
      ],
    });
  }

  async function user(ix, _args, ctx) {
    const opponentId = ix.values[0];
    if (opponentId === ix.userId) return open(ix, [], ctx, '自分自身とは対戦できません。');
    if (ix.raw.data?.resolved?.users?.[opponentId]?.bot) return open(ix, [], ctx, 'Botとは対戦できません。');
    return betScreen(ix, ctx, opponentId);
  }

  async function betScreen(ix, ctx, opponentId, notice = null) {
    const settings = await ctx.settings(ix.guildId);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    const rows = amountRows([screen, 'go', opponentId], balance, {
      maxBet: settings.max_bet,
      customId: id(screen, 'custom', opponentId),
      extra: [backButton(screen, '相手を選び直す')],
    });

    return show(ix, {
      embeds: [
        withNotice(
          embed({
            color: rules.color,
            title: `${em[rules.emojiSlot]} ${rules.title}`,
            description:
              `相手: <@${opponentId}>\n所持金 ${coins(balance, settings)}\n\n` +
              '賭け金を選んでください。**勝った方が両方の賭け金を総取り**します。',
          }),
          notice,
        ),
      ],
      components: rows,
    });
  }

  function custom(ix, [opponentId]) {
    return openModal(amountModal(id(screen, 'amount', opponentId), `${rules.title}の賭け金`));
  }

  async function amount(ix, [opponentId], ctx) {
    const value = readInt(ix, 'amount', { min: 1 });
    if (isError(value)) return betScreen(ix, ctx, opponentId, value.error);
    if (value === null) return betScreen(ix, ctx, opponentId, '賭け金を入力してください。');
    return go(ix, [opponentId, String(value)], ctx);
  }

  async function go(ix, [opponentId, rawBet], ctx) {
    const bet = Number(rawBet);
    const settings = await ctx.settings(ix.guildId);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

    const check = checkBet(bet, balance, settings);
    if (!check.ok) return betScreen(ix, ctx, opponentId, check.message);

    const sent = await startDuel(ctx, {
      game: gameKey,
      guildId: ix.guildId,
      channelId: ix.channelId,
      challengerId: ix.userId,
      opponentId,
      bet,
      settings,
    });
    if (!sent) return betScreen(ix, ctx, opponentId, 'このチャンネルに挑戦状を送れませんでした。');

    return show(ix, {
      embeds: [
        embed({
          color: rules.color,
          title: '挑戦状を送りました',
          description: `<@${opponentId}> に ${rules.title} を申し込みました。チャンネルの投稿から応答してもらってください。`,
        }),
      ],
      components: [row(backButton('games'), homeButton())],
    });
  }

  return { open, user, custom, amount, go };
}

export const rr = duelScreens('rr', {
  screen: 'rr',
  lead: '弾倉6つ、実弾は1発。引くたびに当たる確率が上がっていきます。',
});

export const cs = duelScreens('cs', {
  screen: 'cs',
  lead: 'ためて、守って、撃つ。二人同時に手を選ぶ読み合いです。',
});

export const mine = duelScreens('mine', {
  screen: 'mine',
  lead: '3×3のマスに地雷を埋め合い、交互にマスを取り合います。',
});

export const dd = duelScreens('doors', {
  screen: 'dd',
  lead: '二人で同じ額を出し合い、当たり続けるかぎり倍率が伸びます。最後は山分けか、ひとりじめか。',
  extra: () => [button(id('doors', 'open'), '1人で遊ぶ', { emoji: '👤' })],
});

/* ------------------------------------------------------------------ ブラックジャック */

async function bjOpen(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x1abc9c,
          title: `${em.joker} ブラックジャック`,
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            `21を超えない範囲で、**ディーラー（Bot）より大きい手**を作れば勝ちです。\n\n` +
            `**みんなで**：卓を立てるとチャンネルに投稿され、**${BJ_MAX_PLAYERS}人まで**座れます。\n` +
            '**1人で**：誰も待たずに、その場ですぐ配ります。\n\n' +
            'まず金額を選んでください。ここで決めた額が参加費になります。',
          fields: [
            { name: 'ブラックジャック', value: '最初の2枚で21なら **2.5倍**', inline: true },
            { name: 'ふつうの勝ち', value: '**2倍**', inline: true },
            { name: 'ダブルダウン', value: '賭け金を倍にして1枚だけ引く', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: amountRows(['bj', 'mode'], balance, {
      maxBet: settings.max_bet,
      customId: id('bj', 'custom'),
      extra: [backButton('games')],
    }),
  });
}

/** 金額を決めたあと、1人で遊ぶかみんなでやるかを選ぶ。 */
async function bjMode(ix, [rawBet], ctx) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  const check = checkBet(bet, balance, settings);
  if (!check.ok) return bjOpen(ix, [], ctx, check.message);

  return show(ix, {
    embeds: [
      embed({
        color: 0x1abc9c,
        title: `${em.joker} 参加費 ${coins(bet, settings)}`,
        description: 'どちらで遊びますか？',
        fields: [
          { name: '👤 1人で遊ぶ', value: '誰も待たずに、その場ですぐ配ります。', inline: true },
          {
            name: `👥 みんなで（${BJ_MAX_PLAYERS}人まで）`,
            value: 'チャンネルに卓を投稿して、座る人を待ちます。',
            inline: true,
          },
        ],
      }),
    ],
    components: [
      row(
        button(id('bj', 'solo', String(bet)), '1人で遊ぶ', { emoji: '👤', style: ButtonStyle.SUCCESS }),
        button(id('bj', 'go', String(bet)), 'みんなで', { emoji: '👥', style: ButtonStyle.PRIMARY }),
      ),
      row(button(id('bj', 'open'), '金額を変える', { emoji: '💰' }), homeButton()),
    ],
  });
}

function bjCustom() {
  return openModal(amountModal(id('bj', 'amount'), 'ブラックジャックの参加費'));
}

async function bjAmount(ix, _args, ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return bjOpen(ix, [], ctx, value.error);
  if (value === null) return bjOpen(ix, [], ctx, '参加費を入力してください。');
  return bjMode(ix, [String(value)], ctx);
}

const bjGo = (ix, args, ctx) => bjStart(ix, args, ctx, false);
const bjSolo = (ix, args, ctx) => bjStart(ix, args, ctx, true);

async function bjStart(ix, [rawBet], ctx, solo) {
  const bet = Number(rawBet);
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  const check = checkBet(bet, balance, settings);
  if (!check.ok) return bjOpen(ix, [], ctx, check.message);

  const opened = await openBlackjack(ctx, {
    guildId: ix.guildId,
    channelId: ix.channelId,
    hostId: ix.userId,
    bet,
    settings,
    solo,
  });
  if (!opened.ok) {
    const messages = {
      insufficient: '残高が足りません。',
      post: 'このチャンネルに卓を投稿できませんでした。',
    };
    return bjOpen(ix, [], ctx, messages[opened.reason] ?? '卓を立てられませんでした。');
  }

  return show(ix, {
    embeds: [
      embed({
        color: 0x1abc9c,
        title: solo ? '配りました' : '卓を立てました',
        description: solo
          ? `参加費 ${coins(bet, settings)} で配りました。\nチャンネルのメッセージで **ヒット / スタンド** を押してください。`
          : `参加費 ${coins(bet, settings)} の卓をチャンネルに投稿しました。\n` +
            `ほかの人が座るのを待って、**▶️ 始める** を押してください（${BJ_MAX_PLAYERS}人そろえば自動で始まります）。`,
      }),
    ],
    components: [row(backButton('games'), homeButton())],
  });
}

export const bj = { open: bjOpen, custom: bjCustom, amount: bjAmount, mode: bjMode, go: bjGo, solo: bjSolo };
