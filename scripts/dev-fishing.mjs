/**
 * 釣りゲームを手元で動かすための小さなサーバー。
 * Cloudflare も Discord も使わず、偽の D1 と本物の API ロジックだけで動かす。
 *
 *   node scripts/dev-fishing.mjs [ポート]
 *
 * 起動すると合鍵入りの URL を表示する。ブラウザで開けばそのまま遊べる。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeD1 } from '../test/fake-d1.mjs';
import { handleFishingApi } from '../src/game/api.js';
import * as store from '../src/lib/fishing-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'public');
const port = Number(process.argv[2] || 8788);

const db = createFakeD1(path.join(here, '..', 'migrations'));
const ctx = { db };

const GUILD = 'dev-guild';
const USER = process.env.DEV_USER || 'dev-user';
await store.addBait(db, GUILD, USER, 999);
if (process.env.DEV_ROD) await store.setRod(db, GUILD, USER, process.env.DEV_ROD);
const token = await store.issueSession(db, GUILD, USER, process.env.DEV_NAME || 'テスター');

// 島に人がいる様子も見たいので、もう1人座らせておく
const other = await store.issueSession(db, GUILD, 'dev-other', 'ともだち');
await store.takeSeat(db, other, GUILD, 2);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname.startsWith('/api/fishing/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost${url.pathname}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const out = await handleFishingApi(request, url.pathname.slice('/api/fishing/'.length), ctx);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(await out.text());
    return;
  }

  let file = url.pathname === '/' ? '/play/index.html' : url.pathname;
  if (file.endsWith('/')) file += 'index.html';
  try {
    const body = await fs.readFile(path.join(root, file));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, () => {
  console.log(`http://localhost:${port}/play/#${token}`);
});
