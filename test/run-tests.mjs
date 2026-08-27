// Discord に接続せずにゲーム・通貨・ショップのロジックを検証する簡易テスト。
// 実行: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');
process.env.IMAGE_DIR = path.join(tmp, 'images');
process.env.CLIENT_ID = '123';
process.env.DISCORD_TOKEN = 'x';
process.env.TZ = 'Asia/Tokyo';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (name) => pathToFileURL(path.join(here, '..', 'src', name)).href;

const { loadCommands } = await import(src('lib/loader.js'));
const eco = await import(src('lib/economy.js'));
const act = await import(src('lib/activities.js'));
const shop = await import(src('lib/shop.js'));
const rps = await import(src('lib/rps.js'));
const slot = await import(src('lib/slot.js'));
const fmt = await import(src('lib/format.js'));
const { getDb } = await import(src('lib/db.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('\n[コマンド定義]');
const { commands, components } = await loadCommands();
test('全コマンドが JSON にシリアライズできる', () => {
  const json = [...commands.values()].map((c) => c.data.toJSON());
  assert.equal(json.length, commands.size);
  for (const c of json) assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
});
test('期待するコマンドが揃っている', () => {
  const names = [...commands.keys()].sort();
  assert.deepEqual(names, ['activity','balance','coinflip','economy','help','inventory','leaderboard','menu','pay','report','rps','shop','slot']);
});
test('コンポーネント handler が rps と shop に登録されている', () => {
  assert.deepEqual([...components.keys()].sort(), ['m','rps','shop']);
});

const G = 'guild1', A = 'userA', B = 'userB';
console.log('\n[通貨]');
test('初期残高が入る', () => {
  const s = eco.getSettings(G);
  assert.equal(s.starting_balance, 100);
  assert.equal(eco.getBalance(G, A), 100);
});
test('入金・出金', () => {
  eco.deposit(G, A, 50, 'test');
  assert.equal(eco.getBalance(G, A), 150);
  assert.equal(eco.withdraw(G, A, 100, 'test'), true);
  assert.equal(eco.getBalance(G, A), 50);
});
test('残高不足の出金は失敗して残高が動かない', () => {
  assert.equal(eco.withdraw(G, A, 999, 'test'), false);
  assert.equal(eco.getBalance(G, A), 50);
});
test('送金', () => {
  eco.ensureAccount(G, B);
  assert.equal(eco.transfer(G, A, B, 30, 'pay'), true);
  assert.equal(eco.getBalance(G, A), 20);
  assert.equal(eco.getBalance(G, B), 130);
});
test('残高不足の送金は両者とも動かない', () => {
  assert.equal(eco.transfer(G, A, B, 500, 'pay'), false);
  assert.equal(eco.getBalance(G, A), 20);
  assert.equal(eco.getBalance(G, B), 130);
});
test('管理者調整は0未満にならない', () => {
  eco.adjust(G, A, -9999, 'admin:take');
  assert.equal(eco.getBalance(G, A), 0);
  eco.setBalance(G, A, 1000, 'admin:set');
  assert.equal(eco.getBalance(G, A), 1000);
});
test('ランキングと順位', () => {
  const top = eco.topBalances(G, 10);
  assert.equal(top[0].user_id, A);
  assert.equal(eco.rankOf(G, A), 1);
  assert.equal(eco.rankOf(G, B), 2);
});
test('台帳に全増減が残る', () => {
  const n = getDb().prepare('SELECT COUNT(*) AS n FROM ledger WHERE guild_id = ?').get(G).n;
  assert.ok(n >= 8, `ledger rows: ${n}`);
});

console.log('\n[アクション報告]');
test('プリセット登録', () => {
  for (const p of act.PRESET_ACTIVITIES) act.upsertActivity(G, p);
  assert.equal(act.listActivities(G).length, act.PRESET_ACTIVITIES.length);
});
test('報酬の更新は指定した項目だけ変わる', () => {
  act.upsertActivity(G, { name: '筋トレ', reward: 80 });
  const a = act.getActivity(G, '筋トレ');
  assert.equal(a.reward, 80);
  assert.equal(a.cooldown_sec, 21600);
  assert.equal(a.emoji, '💪');
});
test('クールダウン中は報告できない', () => {
  const a = act.getActivity(G, '筋トレ');
  assert.equal(act.canReport(G, A, a).ok, true);
  act.logReport(G, A, '筋トレ', a.reward, null);
  const gate = act.canReport(G, A, a);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'cooldown');
  assert.ok(gate.retryAtMs > Date.now());
});
test('1日の上限を超えると報告できない', () => {
  const a = act.upsertActivity(G, { name: '早起き', daily_limit: 1, cooldown_sec: 0 });
  act.logReport(G, B, '早起き', a.reward, null);
  const gate = act.canReport(G, B, a);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'daily');
  assert.equal(act.countToday(G, B, '早起き'), 1);
});
test('昨日の報告は今日の回数に含まれない', () => {
  getDb().prepare('UPDATE activity_logs SET created_at = ? WHERE guild_id = ? AND user_id = ? AND activity = ?')
    .run(Date.now() - 36 * 3600 * 1000, G, B, '早起き');
  assert.equal(act.countToday(G, B, '早起き'), 0);
  assert.equal(act.canReport(G, B, act.getActivity(G, '早起き')).ok, true);
});
test('削除できる', () => {
  assert.equal(act.removeActivity(G, '自炊'), true);
  assert.equal(act.removeActivity(G, '自炊'), false);
});

console.log('\n[ショップ]');
let item;
test('出品できる', () => {
  item = shop.createItem({ guildId: G, sellerId: A, name: '肩たたき券', price: 200, stock: 2, description: 'テスト' });
  assert.equal(item.stock, 2);
  assert.equal(item.active, 1);
  assert.equal(shop.countItems(G), 1);
});
test('自分の出品は買えない', () => {
  assert.throws(() => shop.purchase(G, item.id, A), (e) => e.code === 'own_item');
});
test('購入で残高と在庫が動く', () => {
  eco.setBalance(G, B, 500, 'test');
  shop.purchase(G, item.id, B);
  assert.equal(eco.getBalance(G, B), 300);
  assert.equal(shop.getItem(G, item.id).stock, 1);
  assert.equal(shop.getItem(G, item.id).sold, 1);
});
test('在庫が0になると自動で販売停止', () => {
  shop.purchase(G, item.id, B);
  const after = shop.getItem(G, item.id);
  assert.equal(after.stock, 0);
  assert.equal(after.active, 0);
  assert.throws(() => shop.purchase(G, item.id, B), (e) => e.code === 'inactive');
});
test('残高不足の購入は在庫を減らさない（ロールバック）', () => {
  const pricey = shop.createItem({ guildId: G, sellerId: A, name: '高級品', price: 100000, stock: 1 });
  const before = eco.getBalance(G, B);
  assert.throws(() => shop.purchase(G, pricey.id, B), (e) => e.code === 'insufficient');
  const after = shop.getItem(G, pricey.id);
  assert.equal(after.stock, 1);
  assert.equal(after.sold, 0);
  assert.equal(after.active, 1);
  assert.equal(eco.getBalance(G, B), before);
});
test('在庫無制限は何度でも買える', () => {
  const inf = shop.createItem({ guildId: G, sellerId: A, name: '無限券', price: 10, stock: -1 });
  eco.setBalance(G, B, 100, 'test');
  shop.purchase(G, inf.id, B);
  shop.purchase(G, inf.id, B);
  const after = shop.getItem(G, inf.id);
  assert.equal(after.sold, 2);
  assert.equal(after.active, 1);
  assert.equal(eco.getBalance(G, B), 80);
});
test('持ち物と売上に反映される', () => {
  const inv = shop.inventoryOf(G, B);
  assert.ok(inv.find((r) => r.name === '肩たたき券').count === 2);
  assert.ok(inv.find((r) => r.name === '無限券').count === 2);
  const sales = shop.salesOf(G, A);
  assert.equal(sales.reduce((s, r) => s + r.count, 0), 4);
});
test('取り下げると一覧から消える', () => {
  const listed = shop.listItems(G).length;
  shop.deactivateItem(G, shop.listItems(G)[0].id);
  assert.equal(shop.listItems(G).length, listed - 1);
});
test('別サーバーの商品は見えない', () => {
  assert.equal(shop.getItem('guild2', item.id), undefined);
  assert.equal(shop.countItems('guild2'), 0);
});

console.log('\n[じゃんけん]');
test('勝敗判定', () => {
  assert.equal(rps.judge('rock', 'scissors'), 'challenger');
  assert.equal(rps.judge('scissors', 'rock'), 'opponent');
  assert.equal(rps.judge('paper', 'rock'), 'challenger');
  assert.equal(rps.judge('rock', 'paper'), 'opponent');
  assert.equal(rps.judge('paper', 'paper'), 'draw');
});
test('マッチの状態遷移', () => {
  const m = rps.createMatch({ id: 'm1', guildId: G, channelId: 'c', challengerId: A, opponentId: B, bet: 10 });
  assert.equal(m.status, 'pending');
  assert.equal(rps.markPlaying('m1'), true);
  assert.equal(rps.markPlaying('m1'), false, '二重開始できない');
  assert.equal(rps.setHand('m1', 'challenger', 'rock'), true);
  assert.equal(rps.setHand('m1', 'challenger', 'paper'), false, '出し直しできない');
  assert.equal(rps.getMatch('m1').challenger_hand, 'rock');
});
test('あいこで次ラウンドに進むと手がリセットされる', () => {
  rps.setHand('m1', 'opponent', 'rock');
  const next = rps.nextRound('m1');
  assert.equal(next.round, 2);
  assert.equal(next.challenger_hand, null);
  assert.equal(next.opponent_hand, null);
  assert.equal(rps.setHand('m1', 'challenger', 'paper'), true);
});
test('起動時に未決着マッチを返金して中止する', () => {
  const beforeA = eco.getBalance(G, A), beforeB = eco.getBalance(G, B);
  const n = rps.refundStaleMatches();
  assert.equal(n, 1);
  assert.equal(eco.getBalance(G, A), beforeA + 10);
  assert.equal(eco.getBalance(G, B), beforeB + 10);
  assert.equal(rps.getMatch('m1').status, 'cancelled');
  assert.equal(rps.refundStaleMatches(), 0, '二重返金しない');
});

console.log('\n[スロット]');
test('出目は必ず3つ、配当は倍率どおり', () => {
  const symbols = new Set(slot.SLOT_SYMBOLS.map((s) => s.symbol));
  for (let i = 0; i < 500; i++) {
    const r = slot.spin();
    assert.equal(r.reels.length, 3);
    for (const s of r.reels) assert.ok(symbols.has(s));
    if (r.kind === 'triple') assert.ok(r.reels.every((s) => s === r.symbol));
    if (r.kind === 'lose') assert.equal(r.multiplier, 0);
    else assert.ok(r.multiplier > 0);
  }
});
test('還元率が 85〜97% に収まる（胴元の取り分が残る）', () => {
  let payout = 0;
  const n = 300000;
  for (let i = 0; i < n; i++) payout += slot.spin().multiplier;
  const rtp = payout / n;
  assert.ok(rtp > 0.85 && rtp < 0.97, `RTP = ${(rtp * 100).toFixed(2)}%`);
});

console.log('\n[表示ヘルパー]');
test('金額表示', () => {
  assert.equal(fmt.coins(1234, { currency_emoji: '🪙', currency_name: 'コイン' }), '🪙 **1,234** コイン');
});
test('時間表示', () => {
  assert.equal(fmt.duration(30), '30秒');
  assert.equal(fmt.duration(90), '1分30秒');
  assert.equal(fmt.duration(3600), '1時間');
  assert.equal(fmt.duration(21600), '6時間');
  assert.equal(fmt.duration(90000), '1日1時間');
});
test('今日の開始時刻がJST基準', () => {
  const start = fmt.startOfToday();
  const jst = new Date(start + 9 * 3600 * 1000).toISOString();
  assert.match(jst, /T00:00:00/);
  assert.ok(Date.now() - start < 24 * 3600 * 1000);
});

console.log(`\n${passed} 件のテストが通りました`);
fs.rmSync(tmp, { recursive: true, force: true });
