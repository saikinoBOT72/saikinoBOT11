// 釣りゲーム。数値のバランス、保存まわり、ブラウザ向け API、Discord のメニューを
// Cloudflare にも Discord にもつながずに検証する。
import assert from 'node:assert/strict';
import { createRunner, createTestContext, customIds, firstEmbed, rawInteraction, screenText, src } from './harness.mjs';

const fishing = await import(src('lib/fishing.js'));
const store = await import(src('lib/fishing-store.js'));
const api = await import(src('game/api.js'));
const eco = await import(src('lib/economy.js'));
const { handleComponent } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));

const runner = createRunner('[釣り]');
const { test, section } = runner;
const ctx = createTestContext();
const db = ctx.db;
const GUILD = 'g1';
const ME = 'u1';

async function press(customId, options = {}) {
  // オンオフの切り替えも押すので、既定では管理者として押す
  const ix = new Ix(rawInteraction({ customId, admin: true, ...options }));
  const response = await handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

/** ブラウザからの呼び出しを真似る。 */
async function callApi(action, body) {
  const request = new Request(`http://x/api/fishing/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await api.handleFishingApi(request, action, ctx);
  return { status: res.status, body: await res.json() };
}

/* ------------------------------------------------------------- 魚とバランス */

section('魚のマスタ');

await test('78種あり、IDが1から順に並んでいる', () => {
  assert.equal(fishing.FISH.length, 78);
  assert.deepEqual(fishing.FISH.map((f) => f.id), [...Array(78)].map((_, i) => i + 1));
});

await test('ノーマル48・レア24・スーパーレア6', () => {
  const count = { n: 0, r: 0, sr: 0 };
  for (const fish of fishing.FISH) count[fish.rarity]++;
  assert.deepEqual(count, { n: 48, r: 24, sr: 6 });
});

await test('レア度ごとの平均値段が 10 / 100 / 1000 になっている', () => {
  const average = (rarity) => {
    const pool = fishing.FISH.filter((fish) => fish.rarity === rarity);
    return pool.reduce((sum, fish) => sum + fish.price, 0) / pool.length;
  };
  assert.equal(Math.round(average('n')), 10);
  assert.equal(Math.round(average('r')), 100);
  assert.equal(Math.round(average('sr')), 1000);
});

await test('竿を上げるほど儲かるが、伝説でも1時間 +500 コインで頭打ち', () => {
  const perHour = fishing.RODS.map((rod) => fishing.expectedPerHour(rod.key));
  for (let i = 1; i < perHour.length; i++) {
    assert.ok(perHour[i] > perHour[i - 1], `${fishing.RODS[i].name} が前より悪い`);
  }
  assert.ok(perHour[0] < 0, '竹の竿は餌代で赤字になるべき');
  assert.ok(perHour.at(-1) <= 500, `伝説の竿が出しすぎ: ${perHour.at(-1)}`);
});

await test('竿ごとの当たりの出方が指定どおりになる', () => {
  // 乱数を固定して、境目のすぐ内側・すぐ外側を狙う
  const legend = fishing.RODS_BY_KEY.get('legend');
  const justN = fishing.rollFish('legend', () => legend.hit.n - 0.001);
  const justR = fishing.rollFish('legend', () => legend.hit.n + 0.001);
  const justSr = fishing.rollFish('legend', () => 1 - 0.0001);
  assert.equal(justN.rarity, 'n');
  assert.equal(justR.rarity, 'r');
  assert.equal(justSr.rarity, 'sr');
});

await test('大きさは 0.5〜1.5 に収まり、値段も同じ倍率で動く', () => {
  for (let i = 0; i < 300; i++) {
    const mul = fishing.rollSizeMultiplier();
    assert.ok(mul >= 0.5 && mul <= 1.5, `範囲外: ${mul}`);
  }
  const aji = fishing.FISH_BY_ID.get(1);
  assert.equal(fishing.priceOf(aji, 1), aji.price);
  assert.equal(fishing.priceOf(aji, 0.5), Math.round(aji.price * 0.5));
  assert.equal(fishing.priceOf(aji, 1.5), Math.round(aji.price * 1.5));
});

await test('大物・レアほど取り込みが難しい', () => {
  const small = fishing.fightParams(fishing.FISH_BY_ID.get(1), 0.6);   // 小さいノーマル
  const big = fishing.fightParams(fishing.FISH_BY_ID.get(41), 1.4);    // 特大のSR
  assert.ok(big.needed > small.needed, '必要な時間が長いこと');
  assert.ok(big.safe < small.safe, '安全な帯が狭いこと');
  assert.ok(big.pull > small.pull, '引きが強いこと');
});

/* ------------------------------------------------------------- 保存まわり */

section('持ち物と席');

await test('餌は買った数だけ増え、1回投げると1つ減る', async () => {
  await store.addBait(db, GUILD, ME, 3);
  assert.equal((await store.getPlayer(db, GUILD, ME)).bait, 3);
  assert.equal(await store.consumeBait(db, GUILD, ME), true);
  assert.equal((await store.getPlayer(db, GUILD, ME)).bait, 2);
});

await test('餌が0なら投げられない', async () => {
  await store.consumeBait(db, GUILD, ME);
  await store.consumeBait(db, GUILD, ME);
  assert.equal((await store.getPlayer(db, GUILD, ME)).bait, 0);
  assert.equal(await store.consumeBait(db, GUILD, ME), false, '0からマイナスにならない');
});

await test('同じ席には1人しか座れない', async () => {
  const mine = await store.issueSession(db, GUILD, ME, 'わたし');
  const yours = await store.issueSession(db, GUILD, 'u9', 'あなた');
  assert.equal(await store.takeSeat(db, mine, GUILD, 0), true);
  assert.equal(await store.takeSeat(db, yours, GUILD, 0), false, 'ふさがっている席は取れない');
  assert.equal(await store.takeSeat(db, yours, GUILD, 1), true);
  const seats = (await store.island(db, GUILD)).map((row) => row.seat);
  assert.deepEqual(seats, [0, 1]);
});

await test('URLを出し直すと古い合鍵は使えなくなる', async () => {
  const older = await store.issueSession(db, GUILD, 'u8', 'ひと');
  const newer = await store.issueSession(db, GUILD, 'u8', 'ひと');
  assert.equal(await store.getSession(db, older), null);
  assert.ok(await store.getSession(db, newer));
});

await test('あたりは1度に1つだけ', async () => {
  const token = await store.issueSession(db, GUILD, 'u7', 'ひと');
  assert.equal(await store.startFight(db, token, { nonce: 1 }), true);
  assert.equal(await store.startFight(db, token, { nonce: 2 }), false, '重ねてかからない');
  await store.finishFight(db, token, false);
  assert.equal(await store.startFight(db, token, { nonce: 2 }), true, '片付ければまた投げられる');
});

/* ------------------------------------------------------------- ブラウザAPI */

section('ブラウザからの呼び出し');

const PLAYER = 'u5';
let token;

await test('合鍵が違えば何もできない', async () => {
  const bad = await callApi('join', { token: 'a'.repeat(48) });
  assert.equal(bad.status, 401);
});

await test('席に座ってから投げられる', async () => {
  token = await store.issueSession(db, GUILD, PLAYER, 'つりびと');
  await store.addBait(db, GUILD, PLAYER, 5);

  const before = await callApi('cast', { token });
  assert.equal(before.status, 400, '座る前は投げられない');

  const sat = await callApi('seat', { token, seat: 2 });
  assert.equal(sat.body.ok, true);

  const cast = await callApi('cast', { token });
  assert.equal(cast.body.ok, true);
  assert.equal(cast.body.bait, 4, '餌が1つ減る');
  assert.ok(cast.body.biteMs > 0, 'いつかかるかが返る');
  assert.ok(cast.body.fight.needed > 0, '引きの強さが返る');
  assert.equal(cast.body.fish, undefined, '魚の正体は投げた時点では返さない');
});

await test('待ち時間より早い申告は通らない（成功したことにできない）', async () => {
  const session = await store.getSession(db, token);
  const pending = JSON.parse(session.pending);
  const cheat = await callApi('resolve', { token, nonce: pending.nonce, landed: true });
  assert.equal(cheat.body.landed, false, '一瞬で取り込んだ申告は無効');
});

await test('ちゃんと時間をかければ釣れて、在庫と図鑑に入る', async () => {
  const cast = await callApi('cast', { token });
  assert.equal(cast.body.ok, true);

  // 実際に戦ったことにするため、記録上の開始時刻を巻き戻す
  const session = await store.getSession(db, token);
  const pending = JSON.parse(session.pending);
  pending.at = Date.now() - (pending.biteMs + 60_000);
  await db.run('UPDATE fishing_sessions SET pending = ?2 WHERE token = ?1', token, JSON.stringify(pending));

  const done = await callApi('resolve', { token, nonce: pending.nonce, landed: true });
  assert.equal(done.body.landed, true);
  assert.ok(done.body.fish.name, '何が釣れたか返る');
  assert.ok(done.body.fish.price > 0, '売値が付く');
  assert.equal(await store.countInventory(db, GUILD, PLAYER), 1);
  assert.equal((await store.dexOf(db, GUILD, PLAYER)).size, 1);
});

await test('同じあたりを何度も清算できない', async () => {
  const again = await callApi('resolve', { token, nonce: 99, landed: true });
  assert.equal(again.status, 400);
  assert.equal(await store.countInventory(db, GUILD, PLAYER), 1, '在庫が増えていない');
});

await test('餌が切れたら投げられない', async () => {
  await db.run('UPDATE fishing_players SET bait = 0 WHERE guild_id = ?1 AND user_id = ?2', GUILD, PLAYER);
  const out = await callApi('cast', { token });
  assert.equal(out.body.ok, false);
  assert.match(out.body.reason, /餌/);
});

await test('どの応答にも島の様子が相乗りしてくる（別途の問い合わせが要らない）', async () => {
  const ping = await callApi('ping', { token });
  assert.ok(Array.isArray(ping.body.island));
  assert.ok(ping.body.island.some((person) => person.me), '自分が居ることが分かる');
  assert.ok(ping.body.you.rodName, '持ち物も一緒に返る');
});

/* ------------------------------------------------------------- メニュー */

section('Discord の釣りメニュー');

await test('あそぶメニューから釣りに入れる', async () => {
  assert.ok(customIds(await press('m:games:open')).includes('m:fish:open'));
  const payload = await press('m:fish:open');
  assert.match(screenText(payload), /釣り/);
});

await test('管理者でなくても開ける', async () => {
  const payload = await press('m:fish:open', { admin: false });
  assert.match(screenText(payload), /🎣 釣り/);
});

await test('管理メニューでオフにすると入れなくなる', async () => {
  await press('m:admin:gmtoggle:fish', { admin: true });
  assert.match(screenText(await press('m:fish:open')), /遊べません/);
  assert.match(screenText(await press('m:fish:shop')), /遊べません/, '釣り具屋にも入れない');
  await press('m:admin:gmtoggle:fish', { admin: true });
  assert.match(screenText(await press('m:fish:open')), /🎣 釣り/, 'オンに戻せる');
});

await test('どの画面にも同じ custom_id のボタンが2つ無い', async () => {
  for (const screen of ['m:fish:open', 'm:fish:shop', 'm:fish:sell', 'm:fish:dex:0', 'm:fish:url']) {
    const ids = customIds(await press(screen));
    const duplicated = ids.filter((value, index) => ids.indexOf(value) !== index);
    assert.deepEqual(duplicated, [], `${screen} が重複している: ${duplicated.join(', ')}`);
  }
});

await test('置いてあるボタンがすべて実在の操作に届く', async () => {
  const seen = new Set();
  for (const screen of ['m:fish:open', 'm:fish:shop', 'm:fish:dex:0', 'm:fish:url']) {
    for (const target of customIds(await press(screen))) seen.add(target);
  }
  const { findHandler } = await import(src('menu/router.js'));
  for (const target of seen) {
    if (!target.startsWith('m:')) continue;
    assert.ok(findHandler(target), `押しても何も起きないボタン: ${target}`);
  }
});

await test('餌を買うとコインが減って個数が増える', async () => {
  await eco.deposit(db, GUILD, ME, 5000, 'test');
  const before = await eco.getBalance(db, GUILD, ME);
  await press('m:fish:bait:10');
  assert.equal(await eco.getBalance(db, GUILD, ME), before - 10 * fishing.BAIT_PRICE);
  assert.equal((await store.getPlayer(db, GUILD, ME)).bait, 10);
});

await test('お金が足りなければ買えない', async () => {
  await eco.setBalance(db, GUILD, ME, 0, 'test');
  const payload = await press('m:fish:bait:100');
  assert.match(screenText(payload), /足りません/);
  assert.equal((await store.getPlayer(db, GUILD, ME)).bait, 10, '個数は増えていない');
});

await test('竿は順番に、お金があるときだけ買える', async () => {
  await eco.setBalance(db, GUILD, ME, 100, 'test');
  await press('m:fish:rod:glass');
  assert.equal((await store.getPlayer(db, GUILD, ME)).rod, 'bamboo', '足りなければ変わらない');

  await eco.setBalance(db, GUILD, ME, 10000, 'test');
  await press('m:fish:rod:glass');
  assert.equal((await store.getPlayer(db, GUILD, ME)).rod, 'glass');

  const payload = await press('m:fish:rod:glass');
  assert.match(screenText(payload), /もう持っています/);
});

await test('魚を売るとコインになり、図鑑には残る', async () => {
  await store.recordCatch(db, GUILD, ME, 26, 1.5);   // マダイの特大
  await store.recordCatch(db, GUILD, ME, 1, 1.0);
  const before = await eco.getBalance(db, GUILD, ME);
  const expected = fishing.priceOf(fishing.FISH_BY_ID.get(26), 1.5) + fishing.priceOf(fishing.FISH_BY_ID.get(1), 1);

  await press('m:fish:sold:all');
  assert.equal(await eco.getBalance(db, GUILD, ME), before + expected);
  assert.equal(await store.countInventory(db, GUILD, ME), 0, '在庫は空になる');
  assert.equal((await store.dexOf(db, GUILD, ME)).size, 2, '図鑑は残る');
});

await test('図鑑は釣った魚だけ名前が出て、ページを送れる', async () => {
  const first = await press('m:fish:dex:0');
  const text = screenText(first);
  assert.match(text, /マアジ/, '釣った魚は名前が出る');
  assert.match(text, /\?\?\?/, 'まだの魚は伏せられる');
  assert.ok(customIds(first).includes('m:fish:dex:1'), '次のページに行ける');
});

await test('島へ行くURLに合鍵が付いてくる', async () => {
  ctx.origin = 'https://example.workers.dev';
  const payload = await press('m:fish:url');
  assert.match(screenText(payload), /example\.workers\.dev\/play\/#[0-9a-f]{48}/);
});

runner.done();
