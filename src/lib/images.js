import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';

const MAX_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export class ImageError extends Error {}

/**
 * 添付画像をローカルに保存する。
 * Discord の添付URLは期限切れになるため、ショップの画像は自前で保持して都度アップロードし直す。
 * @returns {Promise<string>} 保存したファイル名
 */
export async function saveAttachment(attachment) {
  const contentType = (attachment.contentType ?? '').split(';')[0];
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new ImageError('画像は PNG / JPEG / GIF / WebP のいずれかにしてください。');
  if (attachment.size > MAX_BYTES) throw new ImageError('画像は 8MB 以下にしてください。');

  const res = await fetch(attachment.url);
  if (!res.ok) throw new ImageError('画像のダウンロードに失敗しました。もう一度お試しください。');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new ImageError('画像は 8MB 以下にしてください。');

  fs.mkdirSync(config.imageDir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(config.imageDir, filename), buffer);
  return filename;
}

export function imagePath(filename) {
  return path.join(config.imageDir, filename);
}

/**
 * Embed に画像を載せるための情報を返す。
 * ローカル保存の画像は attachment:// 参照で毎回アップロードする。
 * @returns {{url: string|null, files: import('discord.js').AttachmentBuilder[]}}
 */
export function imagePayload({ image_file: file, image_url: url }) {
  if (file) {
    const filepath = imagePath(file);
    if (fs.existsSync(filepath)) {
      return { url: `attachment://${file}`, files: [new AttachmentBuilder(filepath, { name: file })] };
    }
  }
  return { url: url ?? null, files: [] };
}

export function deleteImage(filename) {
  if (!filename) return;
  fs.rmSync(imagePath(filename), { force: true });
}

/** http(s) の画像URLらしいかの簡易チェック。 */
export function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
