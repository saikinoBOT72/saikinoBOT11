import { deposit, getBalance, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { payoutTable, spin } from '../lib/slot.js';
import { startChallenge } from './rps-challenge.js';
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
  openModal,
  readInt,
  row,
  show,
  withNotice,
} from './common.js';

/* ------------------------------------------------------------------ ゲーム選択 */

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xe67e22,
          title: '🎮 あそぶ',
          description: `所持金 ${coins(balance, settings)}\n\n遊びたいものを選んでください。`,
          fields: [
            { name: '🎰 スロット', value: '3つ揃いで最大 x3000', inline: true },
            { name: '🪙 コイントス', value: '当たれば2倍', inline: true },
            { name: '🃏 ハイ&ロー', value: '連勝で倍率上昇。降り際が勝負', inline: true },
            { name: '✊ じゃんけん', value: '1対1。勝てば総取り', inline: true },
            { name: '🎲 チンチロ', value: '1対1。役で倍率が変わる', inline: true },
            { name: '🗳️ 予想大会', value: 'みんなで賭けて、正解者で山分け', inline: true },
          ],
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('slot', 'open'), 'スロット', { emoji: '🎰', style: ButtonStyle.PRIMARY }),
        button(id('cf', 'open'), 'コイントス', { emoji: '🪙', style: ButtonStyle.PRIMARY }),
        button(id('hl', 'open'), 'ハイ&ロー', { emoji: '🃏', style: ButtonStyle.PRIMARY }),
      ),
      row(
        button(id('rps', 'open'), 'じゃんけん', { emoji: '✊', style: ButtonStyle.SUCCESS }),
        button(id('cc', 'open'), 'チンチロ', { emoji: '🎲', style: ButtonStyle.SUCCESS }),
        button(id('poll', 'open'), '予想大会', { emoji: '🗳️', style: ButtonStyle.SUCCESS }),
      ),
      row(backButton()),
    ],
  });
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

  const reelLine = (reels) => `# ${reels.join(' ｜ ')}`;
  const spinning = (reels, note) =>
    embed({
      color: 0xe67e22,
      title: '🎰 スロット',
      description: `${reelLine(reels)}\n${note}`,
      footer: { text: `賭け金 ${bet.toLocaleString('ja-JP')}` },
    });

  const finalEmbed = embed({
    color: payout > 0 ? 0x2ecc71 : 0x95a5a6,
    title: '🎰 スロット',
    description: `${reelLine(result.reels)}\n${slotHeadline(result, payout, settings)}`,
    fields: [
      { name: '賭け金', value: bet.toLocaleString('ja-JP'), inline: true },
      { name: '収支', value: `${net >= 0 ? '+' : ''}${net.toLocaleString('ja-JP')}`, inline: true },
      { name: '所持金', value: coins(after, settings), inline: true },
    ],
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
    { after: 800, payload: { embeds: [spinning([result.reels[0], '🎲', '🎲'], '回転中…')], components: [] } },
    { after: 800, payload: { embeds: [spinning([result.reels[0], result.reels[1], '🎲'], '回転中…')], components: [] } },
    { after: 800, payload: { embeds: [finalEmbed], components: finalComponents } },
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

  return show(ix, {
    embeds: [spinning(['🎲', '🎲', '🎲'], '**回転中…**')],
    components: [],
  });
}

function slotHeadline(result, payout, settings) {
  if (result.kind === 'triple') {
    return `🎉 **${result.symbol} 3つ揃い！ x${result.multiplier}** — ${coins(payout, settings)} 獲得！`;
  }
  if (result.kind === 'double') {
    return `✨ ${result.symbol} が2つ！ x${result.multiplier} — ${coins(payout, settings)} 獲得`;
  }
  return '残念…もう一度どうぞ';
}

export const slot = { open: slotOpen, bet: slotBet, custom: slotCustom, amount: slotAmount };

/* ------------------------------------------------------------------ コイントス */

const SIDES = { heads: { label: '表', emoji: '🪙' }, tails: { label: '裏', emoji: '🌑' } };

async function cfOpen(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0xf1c40f,
          title: '🪙 コイントス',
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
        title: '🪙 コイントス',
        description: `賭け金は ${coins(bet, settings)}。\n**表か裏かを選んでください。**`,
      }),
    ],
    components: [
      row(
        button(id('cf', 'go', String(bet), 'heads'), '表', { emoji: '🪙', style: ButtonStyle.PRIMARY }),
        button(id('cf', 'go', String(bet), 'tails'), '裏', { emoji: '🌑', style: ButtonStyle.PRIMARY }),
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

  const tossing = (note) =>
    embed({
      color: 0xf1c40f,
      title: '🪙 コイントス',
      description: note,
      footer: { text: `${SIDES[side].label} に ${bet.toLocaleString('ja-JP')}` },
    });

  ctx.animate(ix, [
    { after: 700, payload: { embeds: [tossing('# 🪙\nくるくる…')], components: [] } },
    {
      after: 900,
      payload: {
        embeds: [
          embed({
            color: won ? 0x2ecc71 : 0x95a5a6,
            title: '🪙 コイントス',
            description:
              `# ${SIDES[outcome].emoji}\n結果は **${SIDES[outcome].label}**！\n` +
              (won ? `🎉 的中！ ${coins(bet * 2, settings)} を獲得しました。` : `外れ… ${coins(bet, settings)} を失いました。`),
            fields: [
              { name: '賭け', value: `${SIDES[side].label} / ${bet.toLocaleString('ja-JP')}`, inline: true },
              { name: '所持金', value: coins(after, settings), inline: true },
            ],
          }),
        ],
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

  return show(ix, { embeds: [tossing('コインを弾きました…')], components: [] });
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
