// 5枚ポーカー。役判定・卓の進行・お金の出入りを、Discord にも Cloudflare にも
// つながずに確かめる。
import assert from 'node:assert/strict';
import { createRunner, createTestContext, customIds, rawInteraction, screenText, src } from './harness.mjs';

const poker = await import(src('lib/poker.js'));
const cards = await import(src('lib/cards.js'));
const lib = await import(src('lib/poker-table.js'));
const board = await import(src('menu/poker-table.js'));
const eco = await import(src('lib/economy.js'));
const { handleComponent } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));

const runner = createRunner('[ポーカー]');
const { test, section } = runner;
const ctx = createTestContext();
const db = ctx.db;
const GUILD = 'g1';
const SEATS = ['u1', 'u2', 'u3', 'u4'];

async function press(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

async function pressPk(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await board.handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

/** 札を手で組む。'sA' はスペードのA、'h10' はハートの10。 */
function hand(...codes) {
  const suits = { s: 0, h: 1, d: 2, c: 3 };
  return codes.map((code) => {
    const suit = suits[code[0]];
    const face = code.slice(1);
    const rank = face === 'A' ? 1 : face === 'J' ? 11 : face === 'Q' ? 12 : face === 'K' ? 13 : Number(face);
    return { rank, suit };
  });
}

const rankOf = (...codes) => poker.evaluate(hand(...codes)).rank;

/* ------------------------------------------------------------------ 役判定 */

section('役の判定');

await test('52枚から5枚の全2,598,960通りが、役ごとの正解と一致する', () => {
  // ここが合えば、役判定に穴が無いことがほぼ証明できる
  const deck = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });

  const counts = {};
  let total = 0;
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++) {
            const { rank } = poker.evaluate([deck[a], deck[b], deck[c], deck[d], deck[e]]);
            counts[rank] = (counts[rank] ?? 0) + 1;
            total++;
          }

  assert.equal(total, 2598960, '組み合わせの数が合わない');
  for (const [rank, expected] of Object.entries(poker.EXACT_COUNTS)) {
    assert.equal(counts[rank] ?? 0, expected, `役 ${rank} の通り数が合わない`);
  }
});

await test('それぞれの役を正しく見分ける', () => {
  const R = poker.HAND_RANKS;
  assert.equal(rankOf('sA', 'sK', 'sQ', 'sJ', 's10'), R.STRAIGHT_FLUSH);
  assert.equal(rankOf('s5', 's4', 's3', 's2', 'sA'), R.STRAIGHT_FLUSH, 'A2345 も同じ絵柄ならストレートフラッシュ');
  assert.equal(rankOf('s7', 'h7', 'd7', 'c7', 's2'), R.QUADS);
  assert.equal(rankOf('s7', 'h7', 'd7', 'c2', 's2'), R.FULL_HOUSE);
  assert.equal(rankOf('s2', 's5', 's9', 'sJ', 'sK'), R.FLUSH);
  assert.equal(rankOf('s6', 'h5', 'd4', 'c3', 's2'), R.STRAIGHT);
  assert.equal(rankOf('sA', 'h2', 'd3', 'c4', 's5'), R.STRAIGHT, 'A を 1 として読む');
  assert.equal(rankOf('sA', 'hK', 'dQ', 'cJ', 's10'), R.STRAIGHT, 'A を 14 としても読む');
  assert.equal(rankOf('s7', 'h7', 'd7', 'c3', 's2'), R.TRIPS);
  assert.equal(rankOf('s7', 'h7', 'd3', 'c3', 's2'), R.TWO_PAIR);
  assert.equal(rankOf('s7', 'h7', 'd5', 'c3', 's2'), R.PAIR);
  assert.equal(rankOf('sA', 'h9', 'd5', 'c3', 's2'), R.HIGH);
});

await test('つながっていない札はストレートにしない', () => {
  const R = poker.HAND_RANKS;
  assert.equal(rankOf('sK', 'hQ', 'dJ', 'c10', 's2'), R.HIGH, 'KQJ10-2 はストレートではない');
  assert.equal(rankOf('sA', 'hK', 'dQ', 'cJ', 's9'), R.HIGH);
  assert.equal(rankOf('sA', 'h2', 'd3', 'c4', 's6'), R.HIGH, 'A234-6 もストレートではない');
});

await test('同じ役はキッカーまで見て決める', () => {
  const stronger = (a, b) => poker.compare(poker.evaluate(hand(...a)), poker.evaluate(hand(...b)));

  assert.equal(stronger(['sK', 'hK', 'd9', 'c5', 's2'], ['sQ', 'hQ', 'dA', 'cK', 'sJ']), 1, 'ペアは数字が強い方');
  assert.equal(stronger(['sK', 'hK', 'dA', 'c5', 's2'], ['sK', 'dK', 'hQ', 'c5', 's2']), 1, '同じペアならキッカー');
  assert.equal(stronger(['sK', 'hK', 'd9', 'c5', 's2'], ['dK', 'cK', 'h9', 's5', 'd2']), 0, '完全に同じ強さなら引き分け');
  assert.equal(stronger(['sA', 'hK', 'dQ', 'cJ', 's10'], ['s9', 'h8', 'd7', 'c6', 's5']), 1, 'ストレートは上の札で');
  assert.equal(stronger(['s5', 'h4', 'd3', 'c2', 'sA'], ['s6', 'h5', 'd4', 'c3', 's2']), -1, 'A2345 は一番弱いストレート');
});

await test('ロイヤルストレートフラッシュだけ名前が変わる', () => {
  assert.equal(poker.evaluate(hand('sA', 'sK', 'sQ', 'sJ', 's10')).label, 'ロイヤルストレートフラッシュ');
  assert.match(poker.evaluate(hand('s9', 's8', 's7', 's6', 's5')).label, /^ストレートフラッシュ/);
});

await test('一番強い人たちを選べる（引き分けは複数返る）', () => {
  const winners = poker.bestOf([
    { userId: 'a', cards: hand('sK', 'hK', 'd9', 'c5', 's2') },
    { userId: 'b', cards: hand('dK', 'cK', 'h9', 's5', 'd2') },
    { userId: 'c', cards: hand('sA', 'h9', 'd5', 'c3', 's2') },
  ]);
  assert.deepEqual(winners.map((winner) => winner.userId).sort(), ['a', 'b'], '同点の2人が返る');
});

/* ------------------------------------------------------------------ 卓の流れ */

section('卓の流れ');

/** 4人で卓を立てて配るところまで。 */
async function seatedTable(bet = 200, players = SEATS) {
  for (const userId of players) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  await press(`m:pk:go:${bet}`, { userId: players[0] });
  const table = await db.get('SELECT * FROM poker_tables ORDER BY created_at DESC, rowid DESC');
  for (const userId of players.slice(1)) await pressPk(`pk:join:${table.id}`, { userId });
  await pressPk(`pk:start:${table.id}`, { userId: players[0] });
  return db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id);
}

const totalCoins = async (players = SEATS) =>
  (await Promise.all(players.map((userId) => eco.getBalance(db, GUILD, userId)))).reduce((sum, n) => sum + n, 0);

await test('卓を立てると参加費が引かれ、チャンネルに出る', async () => {
  await eco.setBalance(db, GUILD, 'u1', 1000, 'test');
  const sentBefore = ctx.sent.length;
  await press('m:pk:go:200', { userId: 'u1' });

  assert.equal(ctx.sent.length, sentBefore + 1);
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), 800, '参加費が引かれる');

  const table = await db.get('SELECT * FROM poker_tables ORDER BY created_at DESC, rowid DESC');
  assert.equal(table.status, 'joining');
  assert.equal(lib.stateOf(table).players.length, 1, '立てた人が座っている');
});

await test('4人まで座れて、5人目は断られる', async () => {
  const table = await db.get('SELECT * FROM poker_tables ORDER BY created_at DESC, rowid DESC');
  for (const userId of ['u2', 'u3', 'u4']) {
    await eco.setBalance(db, GUILD, userId, 1000, 'test');
    await pressPk(`pk:join:${table.id}`, { userId });
  }
  const full = await pressPk(`pk:join:${table.id}`, { userId: 'u5' });
  assert.match(screenText(full), /4 人まで/);

  const again = await pressPk(`pk:join:${table.id}`, { userId: 'u2' });
  assert.match(screenText(again), /もう座って/);
  assert.equal(lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).players.length, 4);
});

await test('1人では始められない', async () => {
  await eco.setBalance(db, GUILD, 'u9', 1000, 'test');
  await press('m:pk:go:100', { userId: 'u9' });
  const table = await db.get('SELECT * FROM poker_tables ORDER BY created_at DESC, rowid DESC');
  const denied = await pressPk(`pk:start:${table.id}`, { userId: 'u9' });
  assert.match(screenText(denied), /2人集まらないと/);

  const other = await pressPk(`pk:start:${table.id}`, { userId: 'u2' });
  assert.match(screenText(other), /卓を立てた人だけ/);
});

await test('配ると全員に5枚ずつ配られる', async () => {
  const table = await seatedTable();
  const state = lib.stateOf(table);
  assert.equal(state.phase, 'draw');
  assert.equal(state.players.length, 4);
  for (const player of state.players) {
    assert.equal(player.cards.length, 5, '5枚配る');
    assert.deepEqual(player.keep, [true, true, true, true, true], '最初は全部残す');
    assert.equal(player.exchanged, false);
  }
  // 配った札がだぶっていない
  const all = state.players.flatMap((player) => player.cards.map((card) => `${card.suit}-${card.rank}`));
  assert.equal(new Set(all).size, all.length, '同じ札が2枚出ている');
});

await test('手札は公開のメッセージに出ない', async () => {
  // 前の卓の結果表示（札が出ていて当然）を拾わないよう、ここから数え直す
  ctx.sent.length = 0;
  ctx.edited.length = 0;
  const table = await seatedTable();
  const posted =
    JSON.stringify(ctx.sent.map((entry) => entry.payload)) +
    JSON.stringify(ctx.edited.map((entry) => entry.payload));
  const state = lib.stateOf(table);

  // 実際に配られた20枚が、1枚も公開側に出ていないこと
  // （タイトルの「♠️ ポーカー」と区別するため、札そのものの見た目で調べる）
  const em = await ctx.emoji();
  const dealt = state.players.flatMap((player) => player.cards.map((card) => cards.render(em, card)));
  assert.equal(dealt.length, 20);
  for (const face of dealt) {
    assert.ok(!posted.includes(face), `公開の卓に ${face} が出ている`);
  }
  assert.ok(state.players.every((player) => player.cards.length === 5), '手札自体は持っている');
});

await test('本人だけが自分の手札を見られる', async () => {
  const table = await seatedTable();
  const mine = await pressPk(`pk:hand:${table.id}`, { userId: 'u1' });
  assert.equal(mine.type, 4, '新しいメッセージで返す');
  assert.ok((mine.data.flags & 64) === 64, '本人にだけ見える');
  assert.equal(customIds(mine).filter((id) => id.startsWith(`pk:keep:${table.id}`)).length, 5, '5枚ぶんのボタン');

  const outsider = await pressPk(`pk:hand:${table.id}`, { userId: 'u8' });
  assert.match(screenText(outsider), /座っていません/);
});

await test('残す／捨てるを切り替えて、選んだ札だけ入れ替わる', async () => {
  const table = await seatedTable();
  const before = lib.stateOf(table).players.find((player) => player.userId === 'u1').cards;

  await pressPk(`pk:keep:${table.id}:0`, { userId: 'u1' });
  await pressPk(`pk:keep:${table.id}:1`, { userId: 'u1' });
  const picked = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.deepEqual(picked.players.find((p) => p.userId === 'u1').keep, [false, false, true, true, true]);

  await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  const after = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1');

  assert.equal(after.exchanged, true);
  assert.deepEqual(after.cards.slice(2), before.slice(2), '残した3枚はそのまま');
  const same = (a, b) => a.rank === b.rank && a.suit === b.suit;
  assert.ok(!after.cards.slice(0, 2).every((card, index) => same(card, before[index])), '捨てた2枚は引き直される');
});

await test('5枚全部を替えられる', async () => {
  const table = await seatedTable();
  const before = lib.stateOf(table).players.find((player) => player.userId === 'u1').cards;
  for (let index = 0; index < 5; index++) await pressPk(`pk:keep:${table.id}:${index}`, { userId: 'u1' });
  await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });

  const after = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1').cards;
  const same = (a, b) => a.rank === b.rank && a.suit === b.suit;
  assert.ok(!after.every((card, index) => same(card, before[index])), '5枚とも引き直される');
});

await test('交換は1人1回だけ', async () => {
  const table = await seatedTable();
  await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  const again = await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  assert.match(screenText(again), /もう交換は終わって/);
  const late = await pressPk(`pk:keep:${table.id}:0`, { userId: 'u1' });
  assert.match(screenText(late), /もう交換は終わって/);
});

await test('全員が交換し終わると勝負の場面に進む', async () => {
  const table = await seatedTable();
  for (const userId of SEATS.slice(0, 3)) {
    await pressPk(`pk:swap:${table.id}`, { userId });
    const mid = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
    assert.equal(mid.phase, 'draw', 'まだ全員終わっていない');
  }
  await pressPk(`pk:swap:${table.id}`, { userId: 'u4' });
  const after = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.equal(after.phase, 'bet');
});

/* ------------------------------------------------------------------ 精算 */

section('お金の決着');

/**
 * 交換を全員すませて、勝負の場面まで運ぶ。
 * 総量を確かめるテスト用に、卓を立てる前の合計も返す
 * （途中で測ると、場に預けた参加費を数え落とす）。
 */
async function toBetPhase(bet = 200) {
  for (const userId of SEATS) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  const startTotal = await totalCoins();

  const table = await seatedTable(bet);
  for (const userId of SEATS) await pressPk(`pk:swap:${table.id}`, { userId });
  return { table: await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id), startTotal };
}

await test('勝負に乗ると同額が引かれ、降りると引かれない', async () => {
  const { table } = await toBetPhase(200);
  const before = await eco.getBalance(db, GUILD, 'u1');

  await pressPk(`pk:call:${table.id}`, { userId: 'u1' });
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), before - 200, '乗ると追加で引かれる');

  const beforeFold = await eco.getBalance(db, GUILD, 'u2');
  await pressPk(`pk:fold:${table.id}`, { userId: 'u2' });
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), beforeFold, '降りると引かれない');
});

await test('全員決めると決着し、コインの総量は変わらない', async () => {
  const { table, startTotal } = await toBetPhase(200);

  for (const userId of SEATS) await pressPk(`pk:call:${table.id}`, { userId });
  await ctx.settle();

  const finished = await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id);
  assert.equal(finished.status, 'done');
  assert.equal(await totalCoins(), startTotal, 'コインが湧いたり消えたりしない');

  const shown = JSON.stringify(ctx.edited.at(-1).payload);
  assert.match(shown, /勝ち|引き分け/);
});

await test('1人だけ残ると、手札を見せずに総取りする', async () => {
  const { table } = await toBetPhase(200);
  const before = await eco.getBalance(db, GUILD, 'u3');

  await pressPk(`pk:fold:${table.id}`, { userId: 'u1' });
  await pressPk(`pk:fold:${table.id}`, { userId: 'u2' });
  await pressPk(`pk:call:${table.id}`, { userId: 'u3' });
  await pressPk(`pk:fold:${table.id}`, { userId: 'u4' });
  await ctx.settle();

  // 参加費4人ぶん800 ＋ 自分の追加200 = 1000 が戻る（追加200は引かれている）
  assert.equal(await eco.getBalance(db, GUILD, 'u3'), before - 200 + 1000);
  const shown = JSON.stringify(ctx.edited.at(-1).payload);
  assert.match(shown, /ひとり残って/);
  assert.doesNotMatch(shown, /♠️|♥️|♦️|♣️/, '手札は見せない');
});

await test('全員降りると流れて、参加費が返る', async () => {
  const { table, startTotal } = await toBetPhase(200);

  for (const userId of SEATS) await pressPk(`pk:fold:${table.id}`, { userId });
  await ctx.settle();

  assert.equal(await totalCoins(), startTotal, '参加費が全員に返る');
  assert.match(JSON.stringify(ctx.edited.at(-1).payload), /全員が降りました/);
});

await test('引き分けは山分けし、端数も消えない', async () => {
  const { table, startTotal } = await toBetPhase(100);
  // 同じ強さの手を仕込んで、3人で割り切れない場を作る
  await lib.mutate(
    db,
    table.id,
    ({ state }) => ({
      state: {
        ...state,
        players: state.players.map((player, index) => ({
          ...player,
          cards: index < 3 ? hand('sK', 'hK', 'd9', 'c5', 's2') : hand('s3', 'h4', 'd6', 'c8', 's10'),
          folded: false,
          called: false,
        })),
      },
    }),
    { allow: ['playing'] },
  );
  // 3人が同じ手。1人だけ弱い手
  const fresh = await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id);
  for (const userId of SEATS) await pressPk(`pk:call:${fresh.id}`, { userId });
  await ctx.settle();

  assert.equal(await totalCoins(), startTotal, '山分けでコインが消えない');
  assert.match(JSON.stringify(ctx.edited.at(-1).payload), /引き分け/);
});

await test('座っていない人は勝負にも降りるにも入れない', async () => {
  const { table } = await toBetPhase(200);
  const denied = await pressPk(`pk:call:${table.id}`, { userId: 'u8' });
  assert.match(screenText(denied), /座っていません/);
});

await test('時間切れは流れて、預かったぶんが返る', async () => {
  for (const userId of SEATS) await eco.setBalance(db, GUILD, userId, 2000, 'test');
  const startTotal = await totalCoins();
  const table = await seatedTable(200);

  await db.run('UPDATE poker_tables SET expires_at = 1 WHERE id = ?1', table.id);
  const expired = await lib.expiredTables(db);
  assert.ok(expired.some((row) => row.id === table.id), '見回りが拾う');

  await board.timeOut(ctx, await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.equal(await totalCoins(), startTotal, '全員に返る');
  assert.equal((await db.get('SELECT status FROM poker_tables WHERE id = ?1', table.id)).status, 'cancelled');
});

/* ------------------------------------------------------------------ 入口 */

section('メニューからの入口');

await test('あそぶメニューにポーカーがある', async () => {
  assert.ok(customIds(await press('m:games:open')).includes('m:pk:open'));
  const screen = await press('m:pk:open', { userId: 'u1' });
  assert.match(screenText(screen), /ポーカー/);
  assert.match(screenText(screen), /ストレートフラッシュ/, '役の強さを書いておく');
});

await test('管理画面でオフにするとメンバーは入れない', async () => {
  await press('m:admin:gmtoggle:pk', { admin: true });
  assert.ok(!customIds(await press('m:games:open')).includes('m:pk:open'));
  assert.match(screenText(await press('m:pk:open', { admin: false })), /遊べません/);
  await press('m:admin:gmtoggle:pk', { admin: true });
  assert.ok(customIds(await press('m:games:open')).includes('m:pk:open'));
});

runner.done();
db.close();
