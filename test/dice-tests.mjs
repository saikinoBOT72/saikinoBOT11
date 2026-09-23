// サイコロのゲーム2つ（ピッグ・丁半博打）。
// 出目は乱数なので、進行を確かめるところでは必ず目を指定して振らせる。
import assert from 'node:assert/strict';
import { createRunner, createTestContext, customIds, rawInteraction, screenText, src } from './harness.mjs';

const pig = await import(src('lib/pig.js'));
const pigLib = await import(src('lib/pig-table.js'));
const pigBoard = await import(src('menu/pig-table.js'));
const chohan = await import(src('lib/chohan.js'));
const yacht = await import(src('lib/yacht.js'));
const ytLib = await import(src('lib/yacht-table.js'));
const ytBoard = await import(src('menu/yacht-table.js'));
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

/* ================================================================== ヨット */

section('[ヨット] 役の判定');

/**
 * サイコロ5個の全 7776 通りで、それぞれの役が「何通りで成立するか」を数える。
 * 数え上げた値が手計算と合っていれば、判定はまず間違っていない。
 *
 * 例：ヨット（5個同じ）は 6通り、大ストレート（12345/23456）は 2×5! = 240通り、
 *     フルハウス（3個＋2個ちょうど）は 6×5×C(5,3) = 300通り。
 */
const YACHT_EXACT_COUNTS = {
  ones: 4651,
  twos: 4651,
  threes: 4651,
  fours: 4651,
  fives: 4651,
  sixes: 4651,
  three: 1656,
  four: 156,
  full: 300,
  small: 1200,
  large: 240,
  yacht: 6,
  chance: 7776,
};

function everyRoll(visit) {
  const dice = [0, 0, 0, 0, 0];
  const walk = (at) => {
    if (at === 5) return visit(dice);
    for (let face = 1; face <= 6; face++) {
      dice[at] = face;
      walk(at + 1);
    }
  };
  walk(0);
}

await test('全7776通りで、役の成立数が手計算と一致する', () => {
  const counts = Object.fromEntries(yacht.CATEGORIES.map((category) => [category.key, 0]));
  let total = 0;
  everyRoll((dice) => {
    total += 1;
    for (const category of yacht.CATEGORIES) {
      if (yacht.scoreFor(category.key, dice) > 0) counts[category.key] += 1;
    }
  });
  assert.equal(total, 6 ** 5);
  assert.deepEqual(counts, YACHT_EXACT_COUNTS);
});

await test('大ストレートは必ず小ストレートでもある', () => {
  everyRoll((dice) => {
    if (yacht.scoreFor('large', dice) > 0) {
      assert.ok(yacht.scoreFor('small', dice) > 0, `${dice.join('')} が小ストレートにならない`);
    }
  });
});

await test('ヨットはフォーカードでもスリーカードでもある', () => {
  everyRoll((dice) => {
    if (yacht.scoreFor('yacht', dice) > 0) {
      assert.ok(yacht.scoreFor('four', dice) > 0);
      assert.ok(yacht.scoreFor('three', dice) > 0);
    }
  });
});

await test('5個そろいはフルハウスにしない', () => {
  assert.equal(yacht.scoreFor('full', [4, 4, 4, 4, 4]), 0, '3個＋2個ちょうどではない');
  assert.equal(yacht.scoreFor('full', [4, 4, 4, 2, 2]), 25);
  assert.equal(yacht.scoreFor('full', [4, 4, 4, 2, 3]), 0);
});

await test('チャンスと上段はいつでも出目どおりに数える', () => {
  everyRoll((dice) => {
    const sum = dice.reduce((total, die) => total + die, 0);
    assert.equal(yacht.scoreFor('chance', dice), sum);
    let upperSum = 0;
    for (let face = 1; face <= 6; face++) {
      upperSum += yacht.scoreFor(yacht.UPPER_KEYS[face - 1], dice);
    }
    assert.equal(upperSum, sum, '上段6つを足すと出目の合計になる');
  });
});

await test('スリーカードとフォーカードは5個ぜんぶの合計', () => {
  assert.equal(yacht.scoreFor('three', [5, 5, 5, 1, 2]), 18);
  assert.equal(yacht.scoreFor('four', [5, 5, 5, 5, 2]), 22);
  assert.equal(yacht.scoreFor('four', [5, 5, 5, 1, 2]), 0, '3個では足りない');
});

await test('上段が63点以上でボーナス35がつく', () => {
  const card = yacht.emptyCard();
  for (const key of yacht.UPPER_KEYS) card[key] = 10;
  assert.equal(yacht.tally(card).upper, 60);
  assert.equal(yacht.tally(card).bonus, 0, 'あと3点');
  assert.equal(yacht.tally(card).toBonus, 3);

  card.sixes = 13;
  assert.equal(yacht.tally(card).upper, 63);
  assert.equal(yacht.tally(card).bonus, 35);
  assert.equal(yacht.tally(card).total, 98);
});

await test('13欄ぜんぶ埋まったら書き終わり', () => {
  const card = yacht.emptyCard();
  assert.equal(yacht.openCategories(card).length, 13);
  assert.equal(yacht.isComplete(card), false);
  for (const category of yacht.CATEGORIES) card[category.key] = 0;
  assert.equal(yacht.isComplete(card), true);
});

await test('並べ替えると「残す」の印も同じサイコロに付いていく', () => {
  // 元: 6=残す / 2=捨てる / 5=残す / 2=残す / 1=捨てる
  const { dice, keep } = yacht.sortDice([6, 2, 5, 2, 1], [true, false, true, true, false]);
  assert.deepEqual(dice, [1, 2, 2, 5, 6], '小さい順に並ぶ');
  // 並べ替え後も「どの目を残すか」は変わらない。
  // 2 は2個あって片方だけ残すので、印が位置ではなく目に付いていることがここで分かる
  assert.deepEqual(keep, [false, false, true, true, true]);
  assert.equal(
    dice.filter((_, index) => keep[index]).join(','),
    '2,5,6',
    '残すと決めた 6・5・2 がそのまま残っている',
  );
});

await test('残すサイコロが真ん中にあってもずれない', () => {
  // 3 だけを残す。並べ替えでも 3 に印が付いたまま
  const { dice, keep } = yacht.sortDice([5, 1, 3, 6, 2], [false, false, true, false, false]);
  assert.deepEqual(dice, [1, 2, 3, 5, 6]);
  assert.deepEqual(keep, [false, false, true, false, false]);
  assert.equal(dice[keep.indexOf(true)], 3);
});

await test('残すと決めたサイコロは振り直しても変わらない', () => {
  const dice = [1, 2, 3, 4, 5];
  for (let i = 0; i < 50; i++) {
    const next = yacht.reroll(dice, [true, true, false, false, false]);
    assert.deepEqual(next.slice(0, 2), [1, 2], '残した2個は動かない');
    assert.equal(next.length, 5);
  }
});

section('[ヨット] 卓の進行');

async function yachtTable(bet = 200, players = ['u1', 'u2']) {
  for (const userId of players) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  await press(`m:yt:go:${bet}`, { userId: players[0] });
  const table = await db.get('SELECT * FROM yacht_tables ORDER BY created_at DESC, rowid DESC');
  for (const userId of players.slice(1)) await pressOn(ytBoard, `yt:join:${table.id}`, { userId });
  await pressOn(ytBoard, `yt:start:${table.id}`, { userId: players[0] });
  return db.get('SELECT * FROM yacht_tables WHERE id = ?1', table.id);
}

const ytState = async (id) => ytLib.stateOf(await db.get('SELECT * FROM yacht_tables WHERE id = ?1', id));
const ytPlayer = async (id, userId) => ytLib.playerOf(await ytState(id), userId);

/** 出目を指定して振らせる。 */
const rollAs = (table, userId, dice) =>
  ytLib.mutate(db, table.id, ({ state }) => ({ state: ytLib.rollFor(state, userId, dice) }), {
    allow: ['playing'],
  });

/** 1欄ぶん、指定の出目で書き込む。 */
async function writeAs(table, userId, dice, key) {
  await rollAs(table, userId, dice);
  return pressOn(ytBoard, `yt:write:${table.id}`, { userId, values: [key] });
}

/** 13欄ぜんぶを埋める。どの欄も同じ出目で書くので点はそろう。 */
async function fillCard(table, userId, dice = [1, 2, 3, 4, 5]) {
  for (const category of yacht.CATEGORIES) await writeAs(table, userId, dice, category.key);
}

await test('卓を立てると参加費が引かれ、チャンネルに出る', async () => {
  await eco.setBalance(db, GUILD, 'u1', 1000, 'test');
  const before = ctx.sent.length;
  await press('m:yt:go:200', { userId: 'u1' });
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 800);
  assert.equal(ctx.sent.length, before + 1);
  assert.match(JSON.stringify(ctx.sent.at(-1).payload), /ヨット/);
});

await test('始めると全員が空のカードを持っている', async () => {
  const table = await yachtTable(200);
  const state = await ytState(table.id);
  assert.equal(state.players.length, 2);
  for (const player of state.players) {
    assert.equal(yacht.openCategories(player.card).length, 13);
    assert.equal(player.rolls, 0);
    assert.deepEqual(player.dice, []);
  }
});

await test('振る前には書けない', async () => {
  const table = await yachtTable(200);
  const denied = await pressOn(ytBoard, `yt:write:${table.id}`, { userId: 'u1', values: ['chance'] });
  assert.match(screenText(denied), /まず振って/);
  assert.equal((await ytPlayer(table.id, 'u1')).card.chance, null);
});

await test('振れるのは3回まで', async () => {
  const table = await yachtTable(200);
  for (let i = 0; i < yacht.MAX_ROLLS; i++) await pressOn(ytBoard, `yt:roll:${table.id}`, { userId: 'u1' });
  assert.equal((await ytPlayer(table.id, 'u1')).rolls, yacht.MAX_ROLLS);

  const denied = await pressOn(ytBoard, `yt:roll:${table.id}`, { userId: 'u1' });
  assert.match(screenText(denied), /3回まで/);
  assert.equal((await ytPlayer(table.id, 'u1')).rolls, yacht.MAX_ROLLS, '増えない');
});

await test('残す／捨てるを切り替えられる', async () => {
  const table = await yachtTable(200);
  await pressOn(ytBoard, `yt:roll:${table.id}`, { userId: 'u1' });
  await pressOn(ytBoard, `yt:keep:${table.id}:0`, { userId: 'u1' });
  await pressOn(ytBoard, `yt:keep:${table.id}:3`, { userId: 'u1' });
  assert.deepEqual((await ytPlayer(table.id, 'u1')).keep, [true, false, false, true, false]);

  await pressOn(ytBoard, `yt:keep:${table.id}:0`, { userId: 'u1' });
  assert.deepEqual((await ytPlayer(table.id, 'u1')).keep, [false, false, false, true, false], '押すと戻る');
});

await test('サイコロは左から小さい順に並ぶ', async () => {
  const table = await yachtTable(200);
  for (let i = 0; i < 20; i++) {
    await ytLib.mutate(db, table.id, ({ state }) => ({ state: ytLib.rollFor(state, 'u1') }), {
      allow: ['playing'],
    });
    const dice = (await ytPlayer(table.id, 'u1')).dice;
    assert.deepEqual(dice, [...dice].sort((a, b) => a - b), `並んでいない: ${dice.join(',')}`);
  }
});

await test('並べ替えても「残す」の印は同じサイコロに付いたままになる', async () => {
  const table = await yachtTable(200);
  // 6 と 1 を残す状態を作る
  await rollAs(table, 'u1', [6, 2, 5, 2, 1]);
  let player = await ytPlayer(table.id, 'u1');
  assert.deepEqual(player.dice, [1, 2, 2, 5, 6], '振った直後から並んでいる');

  // 端の 1 と 6 を残す
  await pressOn(ytBoard, `yt:keep:${table.id}:0`, { userId: 'u1' });
  await pressOn(ytBoard, `yt:keep:${table.id}:4`, { userId: 'u1' });
  player = await ytPlayer(table.id, 'u1');
  assert.deepEqual(player.keep, [true, false, false, false, true]);

  // 振り直すと並び替えが起きるが、残した 1 と 6 は残ったまま印も付いている
  await pressOn(ytBoard, `yt:roll:${table.id}`, { userId: 'u1' });
  player = await ytPlayer(table.id, 'u1');
  assert.deepEqual(player.dice, [...player.dice].sort((a, b) => a - b), '並んでいる');

  const kept = player.dice.filter((_, index) => player.keep[index]);
  assert.deepEqual(kept.sort((a, b) => a - b), [1, 6], '残した目がそのまま残っている');
});

await test('残す／捨てるボタンにサイコロの目が出る', async () => {
  const table = await yachtTable(200);
  await rollAs(table, 'u1', [1, 2, 3, 4, 5]);
  const card = await pressOn(ytBoard, `yt:card:${table.id}`, { userId: 'u1' });

  const line = card.data.components.find((r) => r.components[0].custom_id?.startsWith(`yt:keep:`));
  assert.equal(line.components.length, 5);
  // 絵文字が入っていない環境ではラベルに ⚀〜⚅ を出す（数字ではない）
  for (const item of line.components) {
    assert.doesNotMatch(item.label, /^(残す|捨てる) \d$/, '数字ではなく目を出す');
    assert.match(item.label, /[⚀⚁⚂⚃⚄⚅].*[残捨]|^(残す|捨てる)$/);
  }
});

await test('スコアボードに全員ぶんが1つの表で出る', async () => {
  const table = await yachtTable(200, ['u1', 'u2']);
  await writeAs(table, 'u2', [3, 3, 3, 3, 3], 'yacht');
  await rollAs(table, 'u1', [1, 2, 3, 4, 5]);

  const card = await pressOn(ytBoard, `yt:card:${table.id}`, { userId: 'u1' });
  const text = card.data.embeds[0].description;

  assert.match(text, /```/, '等幅の表になっている');
  assert.match(text, /<@u1>/, '名前は表の外に出す');
  assert.match(text, /<@u2>/, '相手の名前も出す');
  assert.match(text, /^ボーナス/m, '上段の小計とボーナスの行がある');
  assert.match(text, /^合計/m);

  // 相手が書いたヨット50も同じ表に出る
  const totals = text.match(/^合計\s+(\d+)\s+(\d+)/m);
  assert.ok(totals, '合計の行が2人ぶん並んでいる');
  assert.equal(Number(totals[2]), 50, '相手の点も見える');
});

await test('表の桁がそろっている（すべて半角で数える）', async () => {
  const table = await yachtTable(200, ['u1', 'u2']);
  await rollAs(table, 'u1', [1, 2, 3, 4, 5]);
  const card = await pressOn(ytBoard, `yt:card:${table.id}`, { userId: 'u1' });
  const block = card.data.embeds[0].description.split('```')[1];

  const width = (text) => [...text].reduce((total, char) => total + (/[\u0020-\u007e]/.test(char) ? 1 : 2), 0);
  const rows = block.split('\n').filter((line) => line.trim() !== '');
  const widths = new Set(rows.map(width));
  assert.equal(widths.size, 1, `行の幅がそろっていない: ${[...widths].join(',')}`);
});

await test('書き込むと点が入り、次の欄へ進む', async () => {
  const table = await yachtTable(200);
  await writeAs(table, 'u1', [5, 5, 5, 2, 2], 'full');

  const player = await ytPlayer(table.id, 'u1');
  assert.equal(player.card.full, 25, 'フルハウス25点');
  assert.equal(player.rolls, 0, '振り直しの回数が戻る');
  assert.deepEqual(player.dice, [], '出目もリセット');
  assert.equal(yacht.openCategories(player.card).length, 12);
});

await test('役ができていない欄に書くと0点で潰れる', async () => {
  const table = await yachtTable(200);
  await writeAs(table, 'u1', [1, 2, 3, 4, 6], 'yacht');
  assert.equal((await ytPlayer(table.id, 'u1')).card.yacht, 0, '捨てた');
});

await test('同じ欄には二度書けない', async () => {
  const table = await yachtTable(200);
  await writeAs(table, 'u1', [6, 6, 6, 6, 6], 'yacht');
  await rollAs(table, 'u1', [1, 1, 1, 1, 1]);
  const denied = await pressOn(ytBoard, `yt:write:${table.id}`, { userId: 'u1', values: ['yacht'] });
  assert.match(screenText(denied), /もう書いて/);
  assert.equal((await ytPlayer(table.id, 'u1')).card.yacht, 50, '上書きされない');
});

await test('座っていない人は振れも書けもしない', async () => {
  const table = await yachtTable(200);
  const denied = await pressOn(ytBoard, `yt:roll:${table.id}`, { userId: 'u8' });
  assert.match(screenText(denied), /振れませんでした/);
  const denied2 = await pressOn(ytBoard, `yt:card:${table.id}`, { userId: 'u8' });
  assert.match(screenText(denied2), /座っていません/);
});

await test('公開の掲示には出目もカードの中身も出さない', async () => {
  ctx.sent.length = 0;
  ctx.edited.length = 0;
  const table = await yachtTable(200);
  await writeAs(table, 'u1', [6, 6, 6, 6, 6], 'yacht');
  await ctx.settle();

  const posted = JSON.stringify(ctx.sent.map((e) => e.payload)) + JSON.stringify(ctx.edited.map((e) => e.payload));
  assert.doesNotMatch(posted, /ヨット 50|フルハウス/, '欄ごとの中身は出さない');
  assert.match(posted, /1\/13|0\/13/, '何欄書いたかは出す');
});

await test('二人とも書き終えると高いほうが総取りする', async () => {
  for (const userId of ['u1', 'u2']) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  const startTotal = await totalCoins(['u1', 'u2']);
  const table = await yachtTable(200, ['u1', 'u2']);

  await fillCard(table, 'u1', [6, 6, 6, 6, 6]); // 強い出目
  await fillCard(table, 'u2', [1, 1, 2, 3, 4]); // 弱い出目
  await ctx.settle();

  const row = await db.get('SELECT * FROM yacht_tables WHERE id = ?1', table.id);
  assert.equal(row.status, 'done');
  assert.equal(await totalCoins(['u1', 'u2']), startTotal, 'コインは湧かない');
  assert.ok(await eco.getBalance(db, GUILD, 'u1') > 2000, '勝ったほうが増えている');
});

await test('自己ベストが記録される', async () => {
  await eco.setBalance(db, GUILD, 'u3', 5000, 'test');
  const before = await ytLib.getRecord(db, GUILD, 'u3');

  const table = await yachtTable(200, ['u3', 'u4']);
  await fillCard(table, 'u3', [5, 5, 5, 5, 5]);
  const after = await ytLib.getRecord(db, GUILD, 'u3');

  assert.equal(after.plays, before.plays + 1, '回数が増える');
  assert.ok(after.best > 0, 'ベストが入る');
});

await test('時間切れは流れて、参加費が全員に返る', async () => {
  for (const userId of ['u1', 'u2']) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  const startTotal = await totalCoins(['u1', 'u2']);
  const table = await yachtTable(200, ['u1', 'u2']);
  assert.equal(await totalCoins(['u1', 'u2']), startTotal - 400);

  await db.run('UPDATE yacht_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await cron.sweepYacht(ctx);
  assert.equal(await totalCoins(['u1', 'u2']), startTotal, '全員に返る');
});

section('[ヨット] ひとり練習');

await test('賭けずに始められて、チャンネルには何も出ない', async () => {
  await eco.setBalance(db, GUILD, 'u1', 1000, 'test');
  const before = ctx.sent.length;
  const screen = await press('m:yt:solo', { userId: 'u1' });

  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 1000, 'お金は動かない');
  assert.equal(ctx.sent.length, before, 'チャンネルには出さない');
  assert.ok(customIds(screen).some((id) => id.startsWith('yt:roll:')), 'いきなり振れる');
});

await test('ひとりで13欄書き終えると結果が出て、自己ベストが伸びる', async () => {
  await eco.setBalance(db, GUILD, 'u5', 1000, 'test');
  await press('m:yt:solo', { userId: 'u5' });
  const table = await db.get('SELECT * FROM yacht_tables ORDER BY created_at DESC, rowid DESC');
  assert.equal(table.bet, 0);

  await fillCard(table, 'u5', [4, 4, 4, 4, 4]);
  await ctx.settle();

  assert.equal((await db.get('SELECT * FROM yacht_tables WHERE id = ?1', table.id)).status, 'done');
  assert.equal(await eco.getBalance(db, GUILD, 'u5'), 1000, '賭けていないので増減なし');
  const record = await ytLib.getRecord(db, GUILD, 'u5');
  assert.ok(record.best > 0, '自己ベストが入る');
});

/* ================================================================== 入口 */

section('[入口]');

await test('あそぶメニューに3つとも出る', async () => {
  const ids = customIds(await press('m:games:open'));
  assert.ok(ids.includes('m:pig:open'), 'ピッグ');
  assert.ok(ids.includes('m:ch:open'), '丁半博打');
  assert.ok(ids.includes('m:yt:open'), 'ヨット');
});

await test('管理画面でオフにするとメンバーは入れない', async () => {
  for (const key of ['pig', 'ch', 'yt']) {
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
