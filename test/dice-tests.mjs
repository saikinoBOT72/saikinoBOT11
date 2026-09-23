// サイコロのゲーム2つ（ピッグ・丁半博打）。
// 出目は乱数なので、進行を確かめるところでは必ず目を指定して振らせる。
import assert from 'node:assert/strict';
import { createRunner, createTestContext, customIds, rawInteraction, screenText, src } from './harness.mjs';

const pig = await import(src('lib/pig.js'));
const pigLib = await import(src('lib/pig-table.js'));
const pigBoard = await import(src('menu/pig-table.js'));
const chohan = await import(src('lib/chohan.js'));
const chLib = await import(src('lib/chohan-table.js'));
const chBoard = await import(src('menu/chohan-table.js'));
const eco = await import(src('lib/economy.js'));
const cron = await import(src('cron.js'));
const { handleComponent } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));

const runner = createRunner('[サイコロ]');
const { test, section } = runner;
const ctx = createTestContext();
const db = ctx.db;
const GUILD = 'g1';
const SEATS = ['u1', 'u2', 'u3', 'u4'];

/** メニュー（m:…）を押す。 */
async function press(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

/** 掲示のボタンを押す。 */
async function pressOn(board, customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await board.handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

const totalCoins = async (players = SEATS) =>
  (await Promise.all(players.map((userId) => eco.getBalance(db, GUILD, userId)))).reduce((sum, n) => sum + n, 0);

/* ================================================================== ピッグ */

section('[ピッグ] ルール');

await test('1が出たら貯金が消え、それ以外は足される', () => {
  assert.deepEqual(pig.applyRoll(0, 10, 1), { die: 1, busted: true, turnTotal: 0, reached: false });
  assert.deepEqual(pig.applyRoll(0, 10, 4), { die: 4, busted: false, turnTotal: 14, reached: false });
});

await test('持ち点と貯金の合計が目標に届いたら上がり', () => {
  assert.equal(pig.applyRoll(pig.GOAL - 5, 0, 4).reached, false, 'あと1点足りない');
  assert.equal(pig.applyRoll(pig.GOAL - 5, 0, 5).reached, true, 'ちょうど届く');
  assert.equal(pig.applyRoll(pig.GOAL - 5, 0, 6).reached, true, '超えても上がり');
});

await test('進み具合のバーは目標で満タンになる', () => {
  assert.equal(pig.bar(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(pig.bar(pig.GOAL), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(pig.bar(pig.GOAL * 2), '▰▰▰▰▰▰▰▰▰▰', '超えても溢れない');
});

await test('振って出る目は1〜6に収まる', () => {
  const seen = new Set();
  for (let i = 0; i < 600; i++) seen.add(pig.rollDie());
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

section('[ピッグ] 卓の進行');

/** 2〜4人が座って始まった卓。 */
async function pigTable(bet = 100, players = SEATS) {
  for (const userId of players) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  await press(`m:pig:go:${bet}`, { userId: players[0] });
  const table = await db.get('SELECT * FROM pig_tables ORDER BY created_at DESC, rowid DESC');
  for (const userId of players.slice(1)) await pressOn(pigBoard, `pg:join:${table.id}`, { userId });
  await pressOn(pigBoard, `pg:start:${table.id}`, { userId: players[0] });
  return db.get('SELECT * FROM pig_tables WHERE id = ?1', table.id);
}

const pigState = async (id) => pigLib.stateOf(await db.get('SELECT * FROM pig_tables WHERE id = ?1', id));

/** 目を指定して振らせる。 */
async function rollWith(table, userId, die) {
  return pigLib.mutate(
    db,
    table.id,
    ({ state }) => {
      if (!pigLib.isTurn(state, userId)) return { reject: 'turn' };
      const result = pigLib.roll(state, die);
      return { state: result.state, status: result.won ? 'done' : 'playing', extra: result };
    },
    { allow: ['playing'] },
  );
}

await test('卓を立てると参加費が引かれ、チャンネルに出る', async () => {
  await eco.setBalance(db, GUILD, 'u1', 1000, 'test');
  const before = ctx.sent.length;
  await press('m:pig:go:100', { userId: 'u1' });

  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 900, '参加費が引かれる');
  assert.equal(ctx.sent.length, before + 1, 'チャンネルに投稿される');
  assert.match(JSON.stringify(ctx.sent.at(-1).payload), /ピッグ/);
});

await test('2人集まらないと始められない', async () => {
  await eco.setBalance(db, GUILD, 'u1', 1000, 'test');
  await press('m:pig:go:100', { userId: 'u1' });
  const table = await db.get('SELECT * FROM pig_tables ORDER BY created_at DESC, rowid DESC');
  const denied = await pressOn(pigBoard, `pg:start:${table.id}`, { userId: 'u1' });
  assert.match(screenText(denied), /2人集まらないと/);
});

await test('始めると最初の手番は卓を立てた人', async () => {
  const table = await pigTable(100);
  const state = await pigState(table.id);
  assert.equal(state.players.length, 4);
  assert.equal(pigLib.current(state).userId, 'u1');
  assert.equal(state.turnTotal, 0);
});

await test('手番じゃない人は押せない', async () => {
  const table = await pigTable(100);
  const denied = await pressOn(pigBoard, `pg:roll:${table.id}`, { userId: 'u2' });
  assert.match(screenText(denied), /の番です/);
  assert.equal((await pigState(table.id)).turnTotal, 0, '何も起きていない');
});

await test('振ると貯金が増え、1が出ると消えて次の人へ', async () => {
  const table = await pigTable(100);
  await rollWith(table, 'u1', 5);
  await rollWith(table, 'u1', 3);
  let state = await pigState(table.id);
  assert.equal(state.turnTotal, 8, '5＋3');
  assert.equal(pigLib.current(state).userId, 'u1', 'まだ自分の番');

  await rollWith(table, 'u1', 1);
  state = await pigState(table.id);
  assert.equal(state.turnTotal, 0, '貯金が消える');
  assert.equal(state.busted, true);
  assert.equal(state.players[0].score, 0, '持ち点も増えていない');
  assert.equal(pigLib.current(state).userId, 'u2', '次の人の番');
});

await test('やめると貯金が持ち点になって次の人へ', async () => {
  const table = await pigTable(100);
  await rollWith(table, 'u1', 6);
  await rollWith(table, 'u1', 4);
  await pressOn(pigBoard, `pg:hold:${table.id}`, { userId: 'u1' });

  const state = await pigState(table.id);
  assert.equal(state.players[0].score, 10, '確定した');
  assert.equal(state.turnTotal, 0);
  assert.equal(pigLib.current(state).userId, 'u2');
});

await test('何も貯まっていないのに「やめる」は押せない', async () => {
  const table = await pigTable(100);
  const denied = await pressOn(pigBoard, `pg:hold:${table.id}`, { userId: 'u1' });
  assert.match(screenText(denied), /まだ何も貯まっていません/);
  assert.equal(pigLib.current(await pigState(table.id)).userId, 'u1', '手番は動かない');
});

await test('手番は4人を順にまわって戻ってくる', async () => {
  const table = await pigTable(100);
  const order = [];
  for (let turn = 0; turn < 5; turn++) {
    const state = await pigState(table.id);
    order.push(pigLib.current(state).userId);
    await rollWith(table, pigLib.current(state).userId, 1); // 1を出して手番を渡す
  }
  assert.deepEqual(order, ['u1', 'u2', 'u3', 'u4', 'u1']);
});

await test('目標に届いた人が場を総取りする', async () => {
  // 場に預けたあとで測ると参加費を数え落とすので、卓を立てる前に測る
  for (const userId of SEATS) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  const startTotal = await totalCoins();
  const table = await pigTable(100);

  // u1 の持ち点を上がり目前まで持っていく
  await pigLib.mutate(
    db,
    table.id,
    ({ state }) => ({
      state: { ...state, players: state.players.map((p, i) => (i === 0 ? { ...p, score: pig.GOAL - 6 } : p)) },
    }),
    { allow: ['playing'] },
  );

  const before = await eco.getBalance(db, GUILD, 'u1');
  const won = await rollWith(table, 'u1', 6);
  assert.equal(won.extra.won, true);
  await pigLib.payWinner(db, table, won.state, 'u1');

  assert.equal(await eco.getBalance(db, GUILD, 'u1'), before + 400, '参加費100×4人を総取り');
  assert.equal(await totalCoins(), startTotal, 'コインは湧かない');
});

await test('決着した卓のボタンはもう効かない', async () => {
  const table = await pigTable(100);
  await db.run("UPDATE pig_tables SET status = 'done' WHERE id = ?1", table.id);
  const denied = await pressOn(pigBoard, `pg:roll:${table.id}`, { userId: 'u1' });
  assert.match(screenText(denied), /もう終わって/);
});

await test('時間切れは流れて、参加費が全員に返る', async () => {
  const startTotal = await (async () => {
    for (const userId of SEATS) await eco.setBalance(db, GUILD, userId, 2000, 'test');
    return totalCoins();
  })();
  const table = await pigTable(100);
  assert.equal(await totalCoins(), startTotal - 400, 'いったん預かっている');

  await db.run('UPDATE pig_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await cron.sweepPig(ctx);
  assert.equal(await totalCoins(), startTotal, '全員に返る');
  assert.equal((await db.get('SELECT * FROM pig_tables WHERE id = ?1', table.id)).status, 'cancelled');
});

await test('画面に全員の点と手番が出る', async () => {
  const table = await pigTable(100);
  await rollWith(table, 'u1', 4);
  const shown = JSON.stringify(
    pigLib.stateOf(await db.get('SELECT * FROM pig_tables WHERE id = ?1', table.id)),
  );
  assert.ok(shown.includes('"turnTotal":4'));

  const board = await pressOn(pigBoard, `pg:roll:${table.id}`, { userId: 'u2' }); // 手番違いで弾かれるだけ
  assert.match(screenText(board), /の番です/);
});

/* ================================================================== 丁半 */

section('[丁半] ルール');

await test('和が偶数なら丁、奇数なら半', () => {
  assert.equal(chohan.sideOf([1, 1]), chohan.CHO);
  assert.equal(chohan.sideOf([3, 5]), chohan.CHO);
  assert.equal(chohan.sideOf([2, 3]), chohan.HAN);
  assert.equal(chohan.sideOf([6, 1]), chohan.HAN);
});

await test('片方にコマが無ければ、そろっていない', () => {
  assert.equal(chohan.ready([{ userId: 'a', side: chohan.CHO, amount: 100 }]), false);
  assert.equal(
    chohan.ready([
      { userId: 'a', side: chohan.CHO, amount: 100 },
      { userId: 'b', side: chohan.HAN, amount: 50 },
    ]),
    true,
  );
});

await test('配当は張った額の比で分け、1コインも余らせない', () => {
  const bets = [
    { userId: 'a', side: chohan.CHO, amount: 100 },
    { userId: 'b', side: chohan.CHO, amount: 200 },
    { userId: 'c', side: chohan.HAN, amount: 250 },
  ];
  const result = chohan.settle(bets, chohan.CHO);
  assert.equal(result.pot, 550);
  assert.equal(
    result.winners.reduce((sum, winner) => sum + winner.payout, 0),
    result.pot,
    '配った合計が場とぴったり合う',
  );
  assert.ok(result.winners[1].payout > result.winners[0].payout, '多く張ったほうが多くもらう');
  assert.deepEqual(result.losers.map((loser) => loser.userId), ['c']);
});

await test('割り切れない配当でもコインが消えない', () => {
  for (const loseAmount of [1, 7, 33, 101, 999]) {
    const bets = [
      { userId: 'a', side: chohan.CHO, amount: 3 },
      { userId: 'b', side: chohan.CHO, amount: 7 },
      { userId: 'c', side: chohan.HAN, amount: loseAmount },
    ];
    const result = chohan.settle(bets, chohan.CHO);
    assert.equal(
      result.winners.reduce((sum, winner) => sum + winner.payout, 0),
      result.pot,
      `外れ ${loseAmount} で端数が消えた`,
    );
  }
});

section('[丁半] 盆の進行');

async function chohanBoard(bet = 100, players = SEATS) {
  for (const userId of players) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  await press(`m:ch:go:${bet}`, { userId: players[0] });
  return db.get('SELECT * FROM chohan_tables ORDER BY created_at DESC, rowid DESC');
}

const chState = async (id) => chLib.stateOf(await db.get('SELECT * FROM chohan_tables WHERE id = ?1', id));

/** 目を指定して開ける。 */
const openWith = async (table, dice) =>
  chLib.openPot(db, await db.get('SELECT * FROM chohan_tables WHERE id = ?1', table.id), dice);

await test('盆を開くと、まだ誰も張っていない状態でチャンネルに出る', async () => {
  const before = ctx.sent.length;
  const table = await chohanBoard(100);
  assert.equal(ctx.sent.length, before + 1);
  assert.match(JSON.stringify(ctx.sent.at(-1).payload), /丁半/);
  assert.deepEqual((await chState(table.id)).bets, [], '張り金はまだ無い');
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 2000, '開くだけならお金はかからない');
});

await test('張るとその場で預かり、何度でも足せる', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 1900);

  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 1800);
  assert.equal(chohan.betOf((await chState(table.id)).bets, 'u1').amount, 200, '2口ぶん');
});

await test('一度張った側から反対側へは移れない', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  const denied = await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u1' });
  assert.match(screenText(denied), /反対側へは移れません/);
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 1900, '余計に引かれない');
});

await test('払えなければ張れず、財布も動かない', async () => {
  const table = await chohanBoard(100);
  await eco.setBalance(db, GUILD, 'u2', 50, 'test');
  const denied = await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' });
  assert.match(screenText(denied), /払えません/);
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), 50);
  assert.deepEqual((await chState(table.id)).bets, [], '張り金は残らない');
});

await test('コマがそろわないと開けられない', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  const before = await eco.getBalance(db, GUILD, 'u1');

  const result = await openWith(table, [2, 2]);
  assert.equal(result.kind, 'unmatched');
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), before + 100, '張ったぶんが返る');
  assert.equal((await db.get('SELECT * FROM chohan_tables WHERE id = ?1', table.id)).status, 'cancelled');
});

await test('開けられるのは盆を開いた人だけ', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' });

  const denied = await pressOn(chBoard, `ch:open:${table.id}`, { userId: 'u2' });
  assert.match(screenText(denied), /盆を開いた人だけ/);
  assert.equal((await chState(table.id)).dice, null, 'まだ開いていない');
});

await test('壺を開けると当たった側が外れた側の金を分ける', async () => {
  const table = await chohanBoard(100);
  const startTotal = await totalCoins();

  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' }); // u1 は 200
  await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' }); // u2 は 100
  const afterBets = await totalCoins();

  const result = await openWith(table, [2, 4]); // 和6 → 丁
  assert.equal(result.kind, 'settled');
  assert.equal(result.winningSide, chohan.CHO);

  assert.equal(await totalCoins(), afterBets + 300, '場の300が配られた');
  assert.equal(await totalCoins(), startTotal, 'コインは湧かない');
  assert.equal((await db.get('SELECT * FROM chohan_tables WHERE id = ?1', table.id)).status, 'done');
});

await test('二重には開けられない', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' });

  await openWith(table, [1, 1]);
  const afterFirst = await totalCoins();
  const again = await openWith(table, [1, 1]);
  assert.equal(again.kind, 'late');
  assert.equal(await totalCoins(), afterFirst, '二度目は何も配らない');
});

await test('開いたあとは張れない', async () => {
  const table = await chohanBoard(100);
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' });
  await openWith(table, [1, 1]);

  const denied = await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u3' });
  assert.match(screenText(denied), /もう終わって|もう壺が開いて/);
  assert.equal(await eco.getBalance(db, GUILD, 'u3'), 2000, '引かれない');
});

await test('時間切れでも、コマがそろっていればちゃんと開く', async () => {
  const table = await chohanBoard(100);
  const startTotal = await totalCoins();
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });
  await pressOn(chBoard, `ch:bet:${table.id}:han`, { userId: 'u2' });

  await db.run('UPDATE chohan_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await cron.sweepChohan(ctx);

  const row = await db.get('SELECT * FROM chohan_tables WHERE id = ?1', table.id);
  assert.equal(row.status, 'done', '流さずに開く');
  assert.ok(chLib.stateOf(row).dice, '出目が記録されている');
  assert.equal(await totalCoins(), startTotal, 'コインは湧かない');
});

await test('時間切れでコマがそろっていなければ返金して流す', async () => {
  const table = await chohanBoard(100);
  const startTotal = await totalCoins();
  await pressOn(chBoard, `ch:bet:${table.id}:cho`, { userId: 'u1' });

  await db.run('UPDATE chohan_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await cron.sweepChohan(ctx);

  assert.equal((await db.get('SELECT * FROM chohan_tables WHERE id = ?1', table.id)).status, 'cancelled');
  assert.equal(await totalCoins(), startTotal, '張ったぶんが返る');
});

/* ================================================================== 入口 */

section('[入口]');

await test('あそぶメニューに2つとも出る', async () => {
  const ids = customIds(await press('m:games:open'));
  assert.ok(ids.includes('m:pig:open'), 'ピッグ');
  assert.ok(ids.includes('m:ch:open'), '丁半博打');
});

await test('管理画面でオフにするとメンバーは入れない', async () => {
  for (const key of ['pig', 'ch']) {
    await press(`m:admin:gmtoggle:${key}`, { admin: true });
    const ids = customIds(await press('m:games:open', { admin: false }));
    assert.ok(!ids.includes(`m:${key}:open`), `${key} のボタンが消える`);
    const denied = await press(`m:${key}:open`, { admin: false });
    assert.doesNotMatch(screenText(denied), /参加費|一口/);
    await press(`m:admin:gmtoggle:${key}`, { admin: true });
  }
});

runner.done();
db.close();
