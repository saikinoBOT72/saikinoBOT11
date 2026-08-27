import { config } from '../config.js';
import { ImageError, saveAttachment } from '../lib/images.js';

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 画像の送り方の案内文。
 * MessageContent インテントが無い場合、Bot にメンションされたメッセージ以外は
 * 添付ファイルが読めないため、メンションをお願いする。
 */
export function uploadHint(client) {
  return config.messageContentIntent
    ? '**このチャンネルに画像を送ってください。**'
    : `**このチャンネルで <@${client.user.id}> をメンションして画像を送ってください。**（例: 「@${client.user.username} 」と入力して画像を添付）`;
}

/**
 * ユーザーが次に送る画像を待って保存する。
 * @returns {Promise<{file: string, message: import('discord.js').Message} | {error: string}>}
 */
export async function awaitImage(interaction, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const channel = interaction.channel;
  if (!channel?.awaitMessages) return { error: 'このチャンネルでは画像を受け取れません。' };

  const collected = await channel.awaitMessages({
    max: 1,
    time: timeoutMs,
    filter: (message) =>
      message.author.id === interaction.user.id &&
      message.attachments.some((attachment) => (attachment.contentType ?? '').startsWith('image/')),
  });

  const message = collected.first();
  if (!message) return { error: '時間切れです。もう一度やり直してください。' };

  const attachment = message.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  try {
    const file = await saveAttachment(attachment);
    await message.react('✅').catch(() => {});
    return { file, message, attachment };
  } catch (error) {
    if (error instanceof ImageError) return { error: error.message };
    throw error;
  }
}
