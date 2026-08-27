import 'dotenv/config';
import path from 'node:path';

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/economy.db'),
  imageDir: path.resolve(process.env.IMAGE_DIR || './data/images'),
  timezone: process.env.TZ || 'Asia/Tokyo',
  // true にすると特権インテント Message Content を使い、メンション無しでも画像を受け取れる
  messageContentIntent: process.env.MESSAGE_CONTENT_INTENT === 'true',
};

/** 起動に最低限必要な環境変数が揃っているか確認する。 */
export function assertConfig({ requireToken = true } = {}) {
  const missing = [];
  if (requireToken && !config.token) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('CLIENT_ID');
  if (missing.length > 0) {
    throw new Error(`環境変数が設定されていません: ${missing.join(', ')}（.env.example を参考に .env を作成してください）`);
  }
}
