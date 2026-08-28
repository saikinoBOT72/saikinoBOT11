// Cloudflare や Discord に接続せずにロジックを動かすための道具。
// D1 は better-sqlite3 製の偽物、Discord API 呼び出しは記録するだけ。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeD1 } from './fake-d1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const src = (name) => pathToFileURL(path.join(here, '..', 'src', name)).href;
export const migrationsDir = path.join(here, '..', 'migrations');

export function createTestContext() {
  const db = createFakeD1(migrationsDir);
  const sent = [];
  const edited = [];
  // 演出（回転中→結果）で送られる書き換えを、待ち時間なしで記録する
  const animated = [];
  const settingsCache = new Map();
  const pending = [];

  return {
    db,
    sent,
    edited,
    animated,
    env: { TIMEZONE: 'Asia/Tokyo' },
    timezone: 'Asia/Tokyo',
    rest: {
      async createMessage(channelId, payload) {
        sent.push({ channelId, payload });
        return { id: `msg${sent.length}` };
      },
      async editMessage(channelId, messageId, payload) {
        edited.push({ channelId, messageId, payload });
        return {};
      },
    },
    async settings(guildId) {
      if (!settingsCache.has(guildId)) {
        const { getSettings } = await import(src('lib/economy.js'));
        settingsCache.set(guildId, await getSettings(db, guildId));
      }
      return settingsCache.get(guildId);
    },
    forgetSettings(guildId) {
      settingsCache.delete(guildId);
    },
    waitUntil(promise) {
      pending.push(promise);
    },
    announce(channelId, payload) {
      if (!channelId) return;
      this.waitUntil(this.rest.createMessage(channelId, payload));
    },
    animate(_ix, steps) {
      for (const step of steps) animated.push(step.payload);
    },
    /** 応答後に走る処理（告知など）が終わるのを待つ。 */
    async settle() {
      await Promise.all(pending.splice(0));
    },
  };
}

const ADMIN_PERMISSION = String(1n << 5n);

/** Discord から届く Interaction の JSON を組み立てる。 */
export function rawInteraction({
  type = 3,
  customId,
  values = [],
  fields = null,
  admin = false,
  userId = 'u1',
  guildId = 'g1',
  channelId = 'c1',
  commandName,
  resolvedUsers = {},
  fromMessage = true,
} = {}) {
  const data = {};
  if (customId) data.custom_id = customId;
  if (values.length > 0) data.values = values;
  if (commandName) data.name = commandName;
  if (Object.keys(resolvedUsers).length > 0) data.resolved = { users: resolvedUsers };
  if (fields) {
    data.components = Object.entries(fields).map(([key, value]) => ({
      type: 1,
      components: [{ type: 4, custom_id: key, value }],
    }));
  }

  return {
    type,
    guild_id: guildId,
    channel_id: channelId,
    data,
    member: {
      nick: 'テスター',
      permissions: admin ? ADMIN_PERMISSION : '0',
      user: { id: userId, username: `user${userId}`, global_name: null, avatar: null },
    },
    ...(fromMessage && type !== 2 ? { message: { id: 'menu-message' } } : {}),
  };
}

/** 画面（Discord に返す JSON）から、置かれているボタンの customId を集める。 */
export function customIds(payload) {
  const ids = [];
  for (const row of payload?.data?.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id) ids.push(component.custom_id);
    }
  }
  return ids;
}

export function embedsOf(payload) {
  return payload?.data?.embeds ?? [];
}

/** 演出の最後（＝実際にユーザーが見る結果）。 */
export function finalFrame(ctx) {
  return ctx.animated.at(-1);
}

export function firstEmbed(payload) {
  return embedsOf(payload)[0] ?? {};
}

/** 画面全体の文字列（お知らせやタイトルの確認用）。 */
export function screenText(payload) {
  return JSON.stringify(payload?.data ?? {});
}

export function createRunner(label) {
  let passed = 0;
  console.log(`\n${label}`);
  return {
    async test(name, fn) {
      try {
        await fn();
        passed++;
        console.log('  ✓', name);
      } catch (error) {
        console.error('  ✗', name, '\n   ', error.message);
        process.exitCode = 1;
      }
    },
    section(name) {
      console.log(`\n${name}`);
    },
    done() {
      console.log(`\n${passed} 件のテストが通りました`);
      return passed;
    },
  };
}
