/**
 * 運命の扉（1人プレイ）。
 * 赤か青の扉を選び、当たれば倍率が伸びて次へ。いつでも持ち帰れる。
 */
import { deposit, getBalance, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { DOORS, MAX_MULTIPLIER, MAX_STEPS, STEP_MULTIPLIER, isCapped, multiply, openDoor, payout } from '../lib/doors.js';
import { modal, textInput } from '../discord/builders.js';
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
import { EMOJI as em } from '../lib/emoji.js';

/* ------------------------------------------------------------------ 進行中の勝負 */

async function getGame(ctx, ix) {
  return ctx.db.get('SELECT * FROM doors_games WHERE guild_id = ?1 AND user_id = ?2', ix.guildId, ix.userId);
}

async function saveGame(ctx, ix, game) {
  await ctx.db.run(
    `INSERT INTO doors_games (guild_id, user_id, bet, multiplier, steps, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       bet = excluded.bet, multiplier = excluded.multiplier, steps = excluded.steps`,
    ix.guildId,
    ix.userId,
    game.bet,
    game.multiplier,
    game.steps,
    Date.now(),
  );
}

async function clearGame(ctx, ix) {
  await ctx.db.run('DELETE FROM doors_games WHERE guild_id = ?1 AND user_id = ?2', ix.guildId, ix.userId);
}

/* ------------------------------------------------------------------ 画面 */

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const running = await getGame(ctx, ix);
  if (running) return table(ix, ctx, running, '前回の続きです。');

  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x8e44ad,
          title: `${em.doors} 運命の扉`,
          description:
            `所持金 ${coins(balance, settings)}\n\n` +
            `目の前に ${DOORS.red.emoji} と ${DOORS.blue.emoji} の扉。**当たりはどちらか一方**です。\n` +
            `当たれば **×${STEP_MULTIPLIER}** ずつ倍率が伸びて次の扉へ。外れたら賭け金は全部なくなります。\n` +
            '**いつでも持ち帰って確定**できます。どこで止めるかがすべてです。\n\n' +
            '**👥 2人で遊ぶ** を選ぶと、二人で同じ額を出し合って、最後に山分けかひとりじめかを決める勝負になります。',
          fields: [
            { name: '1枚あたり', value: `当たる確率 50%・×${STEP_MULTIPLIER}`, inline: true },
            { name: '上限', value: `${MAX_STEPS}枚まで`, inline: true },
          ],
          footer: { text: '1枚で降りれば還元率は約95%。粘るほど下がります' },
        }),
        notice,
      ),
    ],
    components: amountRows(['doors', 'bet'], balance, {
      maxBet: settings.max_bet,
      extra: [button(id('dd', 'open'), '2人で遊ぶ', { emoji: '👥', style: ButtonStyle.SUCCESS }), backButton('games')],
    }),
  });
}

export function custom() {
  return openModal(
    modal(id('doors', 'amount'), '運命の扉', [
      textInput('amount', '賭け金', { placeholder: '例: 250', required: true, max: 12 }),
    ]),
  );
}

export async function amount(ix, _args, ctx) {
  const value = readInt(ix, 'amount', { min: 1 });
  if (isError(value)) return open(ix, [], ctx, value.error);
  return start(ix, ctx, value);
}

export async function bet(ix, [rawBet], ctx) {
  return start(ix, ctx, Number(rawBet));
}

async function start(ix, ctx, betAmount) {
  const settings = await ctx.settings(ix.guildId);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
  const check = checkBet(betAmount, balance, settings);
  if (!check.ok) return open(ix, [], ctx, check.message);

  if (await getGame(ctx, ix)) return open(ix, [], ctx, 'すでに勝負が進んでいます。');
  if (!(await withdraw(ctx.db, ix.guildId, ix.userId, betAmount, 'doors:bet'))) {
    return open(ix, [], ctx, '残高が足りません。');
  }

  const game = { bet: betAmount, multiplier: 1, steps: 0 };
  await saveGame(ctx, ix, game);
  return table(ix, ctx, { bet: game.bet, multiplier: game.multiplier, steps: game.steps });
}

/** 扉の前。次の扉を選ぶ画面。 */
async function table(ix, ctx, game, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const current = payout(game.bet, game.multiplier);

  return show(ix, {
    embeds: [
      withNotice(
        embed({
          color: 0x8e44ad,
          title: `${em.doors} 運命の扉`,
          description:
            `# ${DOORS.red.emoji} 　 ${DOORS.blue.emoji}\n` +
            `**${game.steps + 1}枚目の扉**。どちらを開けますか？`,
          fields: [
            { name: '賭け金', value: `${game.bet.toLocaleString('ja-JP')}`, inline: true },
            { name: 'いまの倍率', value: `×${game.multiplier}（${game.steps}枚）`, inline: true },
            { name: '持ち帰ると', value: coins(current, settings), inline: true },
          ],
          footer: { text: `当たれば ×${STEP_MULTIPLIER}・外れたら全部失います` },
        }),
        notice,
      ),
    ],
    components: [
      row(
        button(id('doors', 'pick', 'red'), DOORS.red.label, { emoji: DOORS.red.emoji, style: ButtonStyle.DANGER }),
        button(id('doors', 'pick', 'blue'), DOORS.blue.label, { emoji: DOORS.blue.emoji, style: ButtonStyle.PRIMARY }),
        button(id('doors', 'stop'), `持ち帰る（${current}）`, {
          emoji: '🏳️',
          style: ButtonStyle.SUCCESS,
          disabled: game.steps === 0,
        }),
      ),
    ],
  });
}

export async function pick(ix, [choice], ctx) {
  const game = await getGame(ctx, ix);
  if (!game) return open(ix, [], ctx, '進行中の勝負がありません。');
  if (!DOORS[choice]) return open(ix, [], ctx, '不明な扉です。');

  const settings = await ctx.settings(ix.guildId);
  const winning = openDoor();
  const hit = winning === choice;

  const opening = embed({
    color: 0x8e44ad,
    title: `${em.doors} 運命の扉`,
    description: `${DOORS[choice].emoji} **${DOORS[choice].label}** に手をかけました…\n\n# 🚪 ❓ 🚪`,
  });

  if (!hit) {
    await clearGame(ctx, ix);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 1000,
        payload: {
          embeds: [
            embed({
              color: 0x95a5a6,
              title: `${em.doors} 運命の扉`,
              description:
                `選んだのは ${DOORS[choice].emoji}、当たりは ${DOORS[winning].emoji} でした。\n` +
                `${coins(game.bet, settings)} を失いました。`,
              fields: [
                { name: 'そこまで', value: `×${game.multiplier}（${game.steps}枚）`, inline: true },
                { name: '所持金', value: coins(balance, settings), inline: true },
              ],
            }),
          ],
          components: [row(button(id('doors', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
        },
      },
    ]);
    return show(ix, { embeds: [opening], components: [] });
  }

  const multiplier = multiply(game.multiplier);
  const steps = game.steps + 1;

  if (isCapped(steps, multiplier)) {
    await clearGame(ctx, ix);
    const won = payout(game.bet, multiplier);
    await deposit(ctx.db, ix.guildId, ix.userId, won, 'doors:win', `×${multiplier}`);
    const balance = await getBalance(ctx.db, ix.guildId, ix.userId);
    ctx.animate(ix, [
      {
        after: 1000,
        payload: {
          embeds: [
            embed({
              color: 0xf1c40f,
              title: `${em.doors} 運命の扉 — 最後の扉！`,
              description:
                `${DOORS[choice].emoji} **当たり！**\n\n` +
                `🎉 **${steps}枚・×${multiplier}**！ ここが終点です。\n${coins(won, settings)} を持ち帰りました！`,
              fields: [{ name: '所持金', value: coins(balance, settings), inline: true }],
            }),
          ],
          components: [row(button(id('doors', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
        },
      },
    ]);
    ctx.announce(ix.channelId, {
      embeds: [
        embed({
          color: 0xf1c40f,
          title: `${em.doors} 運命の扉を踏破！`,
          description: `<@${ix.userId}> が **${steps}枚（×${multiplier}）** を突破！ ${coins(won, settings)} を持ち帰りました。`,
        }),
      ],
    });
    return show(ix, { embeds: [opening], components: [] });
  }

  await saveGame(ctx, ix, { bet: game.bet, multiplier, steps });
  ctx.animate(ix, [
    { after: 1000, payload: await openedFrame(ix, ctx, choice, { bet: game.bet, multiplier, steps }) },
  ]);
  return show(ix, { embeds: [opening], components: [] });
}

/** 当たったあとの扉。次を選べる状態を、演出の最後のコマとして作る。 */
async function openedFrame(ix, ctx, choice, game) {
  const settings = await ctx.settings(ix.guildId);
  const current = payout(game.bet, game.multiplier);

  return {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: `${em.doors} 運命の扉`,
        description:
          `${DOORS[choice].emoji} **当たり！** 扉が開きました。\n\n` +
          `# ${DOORS.red.emoji} 　 ${DOORS.blue.emoji}\n` +
          `**${game.steps + 1}枚目の扉**。次はどちら？`,
        fields: [
          { name: 'いまの倍率', value: `×${game.multiplier}（${game.steps}枚）`, inline: true },
          { name: '持ち帰ると', value: coins(current, settings), inline: true },
        ],
      }),
    ],
    components: [
      row(
        button(id('doors', 'pick', 'red'), DOORS.red.label, { emoji: DOORS.red.emoji, style: ButtonStyle.DANGER }),
        button(id('doors', 'pick', 'blue'), DOORS.blue.label, { emoji: DOORS.blue.emoji, style: ButtonStyle.PRIMARY }),
        button(id('doors', 'stop'), `持ち帰る（${current}）`, { emoji: '🏳️', style: ButtonStyle.SUCCESS }),
      ),
    ],
  };
}

export async function stop(ix, _args, ctx) {
  const game = await getGame(ctx, ix);
  if (!game) return open(ix, [], ctx, '進行中の勝負がありません。');
  if (game.steps === 0) return table(ix, ctx, game, '1枚も開けていないので、まだ持ち帰れません。');

  const settings = await ctx.settings(ix.guildId);
  const won = payout(game.bet, game.multiplier);
  await clearGame(ctx, ix);
  await deposit(ctx.db, ix.guildId, ix.userId, won, 'doors:win', `×${game.multiplier}`);
  const balance = await getBalance(ctx.db, ix.guildId, ix.userId);

  return show(ix, {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: `${em.doors} 運命の扉 — 持ち帰り`,
        description: `${game.steps}枚・**×${game.multiplier}** で引き上げました。\n${coins(won, settings)} を持ち帰りました！`,
        fields: [
          { name: '賭け金', value: `${game.bet.toLocaleString('ja-JP')}`, inline: true },
          { name: '所持金', value: coins(balance, settings), inline: true },
        ],
      }),
    ],
    components: [row(button(id('doors', 'open'), 'もう一度', { emoji: '🔁', style: ButtonStyle.SUCCESS }), homeButton())],
  });
}

export const actions = { open, bet, custom, amount, pick, stop };
