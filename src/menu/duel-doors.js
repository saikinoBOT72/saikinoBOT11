/**
 * 運命の扉（2人プレイ）。
 *
 * 二人で同じ額を出し合い、**どちらが押してもいい**扉を進んでいく。
 * 外れたら二人とも失う。持ち帰るところまで来たら、最後に
 * 「山分け」か「ひとりじめ」かを二人が同時に選ぶ。
 */
import {
  DOORS,
  MAX_STEPS,
  SHARE,
  isCapped,
  multiply,
  openDoor,
  payout,
  splitOrSteal,
} from '../lib/doors.js';
import { finishDuel, mutate, payout as payDuel, userIdOf } from '../lib/duel.js';
import { coins } from '../lib/format.js';
import { button, embed, row } from '../discord/builders.js';
import { ButtonStyle } from '../discord/constants.js';
import { reply, update } from '../discord/respond.js';

export const key = 'doors';
export const title = '運命の扉';
export const emojiSlot = 'doors';
export const color = 0x8e44ad;

export function inviteFields({ settings }) {
  return [{ name: 'ルール', value: RULES }];
}

const RULES = [
  '赤と青の扉、当たりはどちらか一方。**当たれば倍率が伸びて次の扉へ**、外れたらそこで終わりです。',
  `**どちらが押してもかまいません。**最大 ${MAX_STEPS} 回まで進めます。`,
  '',
  'いつでも「持ち帰る」を選べます。持ち帰ると最後に、二人が同時に選びます:',
  `${SHARE.split.emoji} **山分け** — 半分ずつ`,
  `${SHARE.steal.emoji} **ひとりじめ** — 相手が山分けなら全部もらえる`,
  '**二人ともひとりじめを選ぶと、二人とも0**。',
].join('\n');

export async function start(ctx, { duel, settings, em }) {
  const state = { phase: 'doors', steps: 0, multiplier: 1, log: [], choice: { challenger: null, opponent: null } };
  const started = await mutate(ctx.db, duel.id, () => ({ state }));
  if (!started.ok) return { content: '', embeds: [embed({ description: '開始できませんでした。' })], components: [] };
  return board(started.duel, state, settings, em, '最初の扉です。どちらが押してもかまいません。');
}

export async function handle(ix, ctx, { duel, role, action, args }) {
  const settings = await ctx.settings(duel.guild_id);
  const em = await ctx.emoji(duel.guild_id);

  if (action === 'door') return handleDoor(ix, ctx, duel, args[0], settings, em);
  if (action === 'take') return handleTake(ix, ctx, duel, settings, em);
  if (action === 'share') return handleShare(ix, ctx, duel, role, args[0], settings, em);
  return reply({ content: '不明な操作です。' });
}

/* ------------------------------------------------------------------ 扉を開ける */

async function handleDoor(ix, ctx, duel, choice, settings, em) {
  if (!DOORS[choice]) return reply({ content: '不明な扉です。' });

  const winning = openDoor();
  const hit = winning === choice;

  const opened = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.phase !== 'doors') return { reject: 'phase' };

    if (!hit) {
      return {
        state: { ...state, phase: 'lost', opened: { choice, winning } },
        status: 'done',
      };
    }
    const multiplier = multiply(state.multiplier);
    const steps = state.steps + 1;
    return {
      state: {
        ...state,
        steps,
        multiplier,
        log: [...state.log, { choice, winning }].slice(-8),
        phase: isCapped(steps, multiplier) ? 'share' : 'doors',
      },
      extra: { steps, multiplier },
    };
  });

  if (!opened.ok) {
    const messages = { phase: 'いまは扉を選ぶ場面ではありません。', closed: 'この勝負はもう終わっています。' };
    return reply({ content: messages[opened.reason] ?? '開けられませんでした。' });
  }

  const frames = [{ after: 900, payload: openingFrame(duel, em, ix.userId, choice) }];

  if (!hit) {
    // 掛け金は預かったまま没収（誰にも返さない）
    frames.push({ after: 1000, payload: lostPayload(duel, opened.state, settings, em) });
    ctx.animate(ix, frames);
    return update(openingFrame(duel, em, ix.userId, choice));
  }

  const state = opened.state;
  frames.push({
    after: 1000,
    payload:
      state.phase === 'share'
        ? sharePayload(opened.duel, state, settings, em, `🎉 **${state.steps}枚目の扉まで到達！** ここで打ち止めです。`)
        : board(opened.duel, state, settings, em, `${DOORS[choice].emoji} **当たり！** 扉が開きました。`),
  });
  ctx.animate(ix, frames);
  return update(openingFrame(duel, em, ix.userId, choice));
}

/* ------------------------------------------------------------------ 持ち帰る */

async function handleTake(ix, ctx, duel, settings, em) {
  const taken = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.phase !== 'doors') return { reject: 'phase' };
    if (state.steps === 0) return { reject: 'empty' };
    return { state: { ...state, phase: 'share' } };
  });

  if (!taken.ok) {
    const messages = {
      empty: '1枚目の扉を開けてからでないと持ち帰れません。',
      phase: 'いまは持ち帰る場面ではありません。',
      closed: 'この勝負はもう終わっています。',
    };
    return reply({ content: messages[taken.reason] ?? '持ち帰れませんでした。' });
  }

  return update(sharePayload(taken.duel, taken.state, settings, em, `<@${ix.userId}> がここで持ち帰ることにしました。`));
}

/* ------------------------------------------------------------------ 山分けか、ひとりじめか */

async function handleShare(ix, ctx, duel, role, choice, settings, em) {
  if (!SHARE[choice]) return reply({ content: '不明な選択です。' });

  const chosen = await mutate(ctx.db, duel.id, ({ state }) => {
    if (state.phase !== 'share') return { reject: 'phase' };
    if (state.choice[role]) return { reject: 'already' };
    return { state: { ...state, choice: { ...state.choice, [role]: choice } } };
  });

  if (!chosen.ok) {
    const messages = {
      already: 'もう選んでいます。相手を待ってください。',
      phase: 'いまは選ぶ場面ではありません。',
      closed: 'この勝負はもう終わっています。',
      busy: '混み合っています。もう一度押してください。',
    };
    return reply({ content: messages[chosen.reason] ?? '選べませんでした。' });
  }

  const state = chosen.state;
  if (!state.choice.challenger || !state.choice.opponent) {
    ctx.waitUntil(refreshBoard(ctx, chosen.duel, state, settings, em));
    return reply({ content: `${SHARE[choice].emoji} **${SHARE[choice].label}** を選びました。相手を待っています…` });
  }

  const prize = payout(duel.escrow * 2, state.multiplier);
  const share = splitOrSteal(prize, state.choice);
  if (!(await finishDuel(ctx.db, chosen.duel, state))) return reply({ content: 'この勝負はもう終わっています。' });
  await payDuel(ctx.db, duel, { challenger: share.challenger, opponent: share.opponent }, 'doors:win');

  return update(resultPayload(duel, state, share, prize, settings, em));
}

async function refreshBoard(ctx, duel, state, settings, em) {
  if (!duel.message_id) return;
  await ctx.rest
    .editMessage(duel.channel_id, duel.message_id, sharePayload(duel, state, settings, em))
    .catch((error) => console.error('運命の扉の表示更新に失敗:', error));
}

/* ------------------------------------------------------------------ 表示 */

function openingFrame(duel, em, userId, choice) {
  return {
    content: '',
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description: `<@${userId}> が ${DOORS[choice].emoji} **${DOORS[choice].label}** に手をかけました…\n\n# 🚪 ❓ 🚪`,
      }),
    ],
    components: [],
  };
}

export function board(duel, state, settings, em, headline = null) {
  const current = payout(duel.escrow * 2, state.multiplier);
  const history = state.log.map((entry) => DOORS[entry.choice].emoji).join('');

  return {
    content: `<@${duel.challenger_id}> <@${duel.opponent_id}>`,
    embeds: [
      embed({
        color,
        title: `${em[emojiSlot]} ${title}`,
        description:
          (headline ? `${headline}\n\n` : '') +
          `# ${DOORS.red.emoji} 　 ${DOORS.blue.emoji}\n` +
          `**${state.steps + 1}枚目の扉**。当たりはどちらか一方です。\n` +
          (history ? `\nここまで: ${history}` : ''),
        fields: [
          { name: 'いまの倍率', value: `×${state.multiplier}（${state.steps}枚）`, inline: true },
          { name: '持ち帰ると', value: coins(current, settings), inline: true },
          { name: '外したら', value: '二人とも全部失います', inline: true },
        ],
        footer: { text: `どちらが押してもかまいません・最大${MAX_STEPS}枚` },
      }),
    ],
    components: [
      row(
        button(`d:door:${duel.id}:red`, DOORS.red.label, { emoji: DOORS.red.emoji, style: ButtonStyle.DANGER }),
        button(`d:door:${duel.id}:blue`, DOORS.blue.label, { emoji: DOORS.blue.emoji, style: ButtonStyle.PRIMARY }),
        button(`d:take:${duel.id}`, `持ち帰る（${current}）`, {
          emoji: '🏳️',
          style: ButtonStyle.SUCCESS,
          disabled: state.steps === 0,
        }),
      ),
    ],
    allowed_mentions: { users: [duel.challenger_id, duel.opponent_id] },
  };
}

function sharePayload(duel, state, settings, em, headline = null) {
  const prize = payout(duel.escrow * 2, state.multiplier);
  const waiting = [];
  if (!state.choice.challenger) waiting.push(duel.challenger_id);
  if (!state.choice.opponent) waiting.push(duel.opponent_id);

  return {
    content: waiting.map((userId) => `<@${userId}>`).join(' '),
    embeds: [
      embed({
        color: 0xf1c40f,
        title: `${em[emojiSlot]} ${title} — 山分け？ ひとりじめ？`,
        description:
          (headline ? `${headline}\n\n` : '') +
          `**${state.steps}枚**の扉を突破。取り分は ${coins(prize, settings)} です。\n\n` +
          `二人とも ${SHARE.split.emoji} 山分け → **半分ずつ**\n` +
          `片方だけ ${SHARE.steal.emoji} ひとりじめ → **その人が全部**\n` +
          `二人とも ${SHARE.steal.emoji} ひとりじめ → **二人とも0**\n\n` +
          '相手が何を選んだかは、二人そろうまで分かりません。',
        fields: [
          { name: '挑戦者', value: shareStatus(duel.challenger_id, state.choice.challenger), inline: true },
          { name: '相手', value: shareStatus(duel.opponent_id, state.choice.opponent), inline: true },
        ],
      }),
    ],
    components: [
      row(
        button(`d:share:${duel.id}:split`, SHARE.split.label, {
          emoji: SHARE.split.emoji,
          style: ButtonStyle.SUCCESS,
        }),
        button(`d:share:${duel.id}:steal`, SHARE.steal.label, {
          emoji: SHARE.steal.emoji,
          style: ButtonStyle.DANGER,
        }),
      ),
    ],
    allowed_mentions: { users: waiting },
  };
}

function shareStatus(userId, choice) {
  return `<@${userId}>\n${choice ? '✅ 選びました' : '⏳ 考え中'}`;
}

function lostPayload(duel, state, settings, em) {
  const { choice, winning } = state.opened;
  return {
    content: '',
    embeds: [
      embed({
        color: 0x95a5a6,
        title: `${em[emojiSlot]} ${title} — 終了`,
        description:
          `選んだのは ${DOORS[choice].emoji}、当たりは ${DOORS[winning].emoji} でした。\n\n` +
          `**${state.steps}枚**まで進みましたが、ここで終わりです。\n` +
          `${coins(duel.escrow * 2, settings)} は消えました。`,
      }),
    ],
    components: [],
  };
}

function resultPayload(duel, state, share, prize, settings, em) {
  const lines = [
    `<@${duel.challenger_id}>　${SHARE[state.choice.challenger].emoji} ${SHARE[state.choice.challenger].label}`,
    `<@${duel.opponent_id}>　${SHARE[state.choice.opponent].emoji} ${SHARE[state.choice.opponent].label}`,
    '',
  ];
  if (share.kind === 'split') {
    lines.push(`🤝 **山分け成立！** ${coins(prize, settings)} を分け合いました。`);
  } else if (share.kind === 'both-steal') {
    lines.push(`😈 **二人ともひとりじめ**。${coins(prize, settings)} は誰の手にも渡りませんでした。`);
  } else {
    const winnerId = share.kind === 'challenger-steal' ? duel.challenger_id : duel.opponent_id;
    lines.push(`😈 **<@${winnerId}> がひとりじめ！** ${coins(prize, settings)} を持っていきました。`);
  }
  lines.push(
    '',
    `<@${duel.challenger_id}> → ${share.challenger}　/　<@${duel.opponent_id}> → ${share.opponent}`,
  );

  return {
    content: '',
    embeds: [
      embed({
        color: share.kind === 'split' ? 0x2ecc71 : 0xe74c3c,
        title: `${em[emojiSlot]} ${title} 結果`,
        description: lines.join('\n'),
      }),
    ],
    components: [],
  };
}
