import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { deposit, getSettings, withdraw } from '../lib/economy.js';
import { checkBet } from '../lib/wager.js';
import { coins } from '../lib/format.js';
import { HANDS, createMatch, getMatch, judge, markPlaying, nextRound, refund, setHand, setMessageId, setStatus } from '../lib/rps.js';

export const namespace = 'rps';

const INVITE_TIMEOUT_MS = 120_000;
const PLAY_TIMEOUT_MS = 180_000;
const MAX_DRAWS = 5;

/** 対戦ID → タイムアウトタイマー */
const timers = new Map();

export const data = new SlashCommandBuilder()
  .setName('rps')
  .setDescription('じゃんけんで他のメンバーと勝負する')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('opponent').setDescription('対戦相手').setRequired(true))
  .addIntegerOption((o) => o.setName('bet').setDescription('賭け金（0で賭けなし）').setRequired(true).setMinValue(0));

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const settings = getSettings(guildId);
  const opponent = interaction.options.getUser('opponent');
  const bet = interaction.options.getInteger('bet');

  if (opponent.id === interaction.user.id) {
    await interaction.reply({ content: '自分自身とは対戦できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (opponent.bot) {
    await interaction.reply({ content: 'Botとは対戦できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (bet > 0) {
    const check = checkBet(guildId, interaction.user.id, bet, settings);
    if (!check.ok) {
      await interaction.reply({ content: check.message, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const id = randomUUID();
  createMatch({ id, guildId, channelId: interaction.channelId, challengerId: interaction.user.id, opponentId: opponent.id, bet });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✊✌️🖐️ じゃんけん勝負！')
    .setDescription(
      `<@${interaction.user.id}> が <@${opponent.id}> に勝負を挑みました。\n` +
        (bet > 0 ? `賭け金は ${coins(bet, settings)}（勝者が総取り）` : '賭けなしの真剣勝負'),
    )
    .setFooter({ text: '2分以内に応答がなければ自動でキャンセルされます' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps:accept:${id}`).setLabel('受けて立つ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rps:decline:${id}`).setLabel('やめておく').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row] });
  const message = await interaction.fetchReply();
  setMessageId(id, message.id);

  scheduleTimeout(interaction.client, id, INVITE_TIMEOUT_MS);
}

export async function handleComponent(interaction) {
  const [, action, id, hand] = interaction.customId.split(':');
  const match = getMatch(id);

  if (!match || match.status === 'done' || match.status === 'cancelled') {
    await interaction.reply({ content: 'この勝負はすでに終了しています。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'accept' || action === 'decline') return handleInvite(interaction, match, action);
  if (action === 'hand') return handleHand(interaction, match, hand);
}

async function handleInvite(interaction, match, action) {
  if (interaction.user.id !== match.opponent_id) {
    await interaction.reply({ content: 'この勝負に呼ばれているのはあなたではありません。', flags: MessageFlags.Ephemeral });
    return;
  }

  const settings = getSettings(match.guild_id);

  if (action === 'decline') {
    clearTimer(match.id);
    setStatus(match.id, 'cancelled');
    await interaction.update({
      content: '',
      embeds: [
        new EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle('じゃんけん中止')
          .setDescription(`<@${match.opponent_id}> は勝負を断りました。`),
      ],
      components: [],
    });
    return;
  }

  if (!markPlaying(match.id)) {
    await interaction.reply({ content: 'この勝負はすでに開始されています。', flags: MessageFlags.Ephemeral });
    return;
  }

  // 賭け金を先に預かる。どちらかが足りなければ元に戻して中止する
  if (match.bet > 0) {
    if (!withdraw(match.guild_id, match.challenger_id, match.bet, 'rps:bet', match.id)) {
      setStatus(match.id, 'cancelled');
      clearTimer(match.id);
      await interaction.update({
        content: '',
        embeds: [cancelEmbed(`<@${match.challenger_id}> の残高が足りないため中止しました。`)],
        components: [],
      });
      return;
    }
    if (!withdraw(match.guild_id, match.opponent_id, match.bet, 'rps:bet', match.id)) {
      deposit(match.guild_id, match.challenger_id, match.bet, 'rps:refund', match.id);
      setStatus(match.id, 'cancelled');
      clearTimer(match.id);
      await interaction.update({
        content: '',
        embeds: [cancelEmbed(`<@${match.opponent_id}> の残高が足りないため中止しました。`)],
        components: [],
      });
      return;
    }
  }

  scheduleTimeout(interaction.client, match.id, PLAY_TIMEOUT_MS);
  await interaction.update({
    content: `<@${match.challenger_id}> <@${match.opponent_id}>`,
    embeds: [playEmbed(match, settings, 1)],
    components: [handRow(match.id)],
  });
}

async function handleHand(interaction, match, hand) {
  const role =
    interaction.user.id === match.challenger_id ? 'challenger' : interaction.user.id === match.opponent_id ? 'opponent' : null;
  if (!role) {
    await interaction.reply({ content: 'この勝負の参加者ではありません。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!HANDS[hand]) return;

  if (!setHand(match.id, role, hand)) {
    await interaction.reply({ content: 'すでに手を出しています。相手を待ちましょう。', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = getMatch(match.id);
  await interaction.reply({ content: `${HANDS[hand].emoji} ${HANDS[hand].label} を出しました。`, flags: MessageFlags.Ephemeral });

  if (!updated.challenger_hand || !updated.opponent_hand) return;
  await resolve(interaction.client, updated);
}

async function resolve(client, match) {
  const settings = getSettings(match.guild_id);
  const result = judge(match.challenger_hand, match.opponent_hand);
  const message = await fetchMatchMessage(client, match).catch(() => null);

  const handsLine =
    `<@${match.challenger_id}> ${HANDS[match.challenger_hand].emoji} ` +
    `vs ${HANDS[match.opponent_hand].emoji} <@${match.opponent_id}>`;

  if (result === 'draw') {
    if (match.round >= MAX_DRAWS) {
      clearTimer(match.id);
      setStatus(match.id, 'done');
      refund(match, 'rps:refund');
      await message?.edit({
        content: '',
        embeds: [
          new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle('🤝 引き分け')
            .setDescription(`${handsLine}\n\nあいこが ${MAX_DRAWS} 回続いたので引き分け。賭け金は返金しました。`),
        ],
        components: [],
      });
      return;
    }
    const next = nextRound(match.id);
    await message?.edit({
      content: `<@${match.challenger_id}> <@${match.opponent_id}>`,
      embeds: [
        playEmbed(next, settings, next.round).setDescription(
          `${handsLine}\n\n**あいこ！** もう一度手を選んでください。`,
        ),
      ],
      components: [handRow(match.id)],
    });
    return;
  }

  clearTimer(match.id);
  setStatus(match.id, 'done');
  const winnerId = result === 'challenger' ? match.challenger_id : match.opponent_id;
  const loserId = result === 'challenger' ? match.opponent_id : match.challenger_id;
  if (match.bet > 0) deposit(match.guild_id, winnerId, match.bet * 2, 'rps:win', match.id);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🏆 じゃんけん結果')
    .setDescription(
      `${handsLine}\n\n**<@${winnerId}> の勝ち！**` +
        (match.bet > 0 ? `\n${coins(match.bet * 2, settings)} を獲得（<@${loserId}> は ${match.bet} を失いました）` : ''),
    );

  await message?.edit({ content: '', embeds: [embed], components: [] });
}

function playEmbed(match, settings, round) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✊✌️🖐️ じゃんけん')
    .setDescription(
      `<@${match.challenger_id}> vs <@${match.opponent_id}>\n` +
        (match.bet > 0 ? `賭け金 ${coins(match.bet, settings)}（勝者が総取り）\n` : '') +
        '\n二人ともボタンで手を選んでください。選んだ手は相手には見えません。',
    )
    .setFooter({ text: round > 1 ? `第${round}ラウンド` : '3分以内に選ばないと引き分け返金になります' });
}

function handRow(id) {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(HANDS).map(([key, meta]) =>
      new ButtonBuilder().setCustomId(`rps:hand:${id}:${key}`).setLabel(meta.label).setEmoji(meta.emoji).setStyle(ButtonStyle.Primary),
    ),
  );
}

function cancelEmbed(text) {
  return new EmbedBuilder().setColor(0xe74c3c).setTitle('じゃんけん中止').setDescription(text);
}

async function fetchMatchMessage(client, match) {
  const channel = await client.channels.fetch(match.channel_id);
  return channel.messages.fetch(match.message_id);
}

function scheduleTimeout(client, id, ms) {
  clearTimer(id);
  const timer = setTimeout(() => {
    timers.delete(id);
    void expire(client, id);
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(id, timer);
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

async function expire(client, id) {
  const match = getMatch(id);
  if (!match || match.status === 'done' || match.status === 'cancelled') return;
  const wasPlaying = match.status === 'playing';
  setStatus(id, 'cancelled');
  if (wasPlaying) refund(match, 'rps:refund');

  const message = await fetchMatchMessage(client, match).catch(() => null);
  await message
    ?.edit({
      content: '',
      embeds: [cancelEmbed(wasPlaying ? '時間切れのため中止しました。賭け金は返金しました。' : '時間切れのため勝負は流れました。')],
      components: [],
    })
    .catch(() => {});
}
