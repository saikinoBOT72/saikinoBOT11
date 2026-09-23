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

/**
 * 「始める」は先に受け取ったとだけ返して、掲示はあとから書き換える形にしてある。
 * その書き換えの中身を取る。
 */
function lastBoard() {
  return ctx.edited.at(-1)?.payload ?? {};
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

await test('配った直後の掲示は、あとから書き換えて出す', async () => {
  const table = await seatedTable();
  assert.equal(table.status, 'playing', '配れている');
  assert.match(JSON.stringify(lastBoard()), /札の交換/, '掲示が交換の場面になる');
  assert.match(JSON.stringify(lastBoard()), /pk:hand/, '手札を見るボタンが出る');
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

await test('応答が届かず掲示が取り残されても、押し直せば追いつく', async () => {
  // Discord に応答が届かないと、卓は進んでいるのに掲示が募集中のまま残る。
  // そこで押し直したときに行き止まりにせず、いまの状態を描き直す
  const table = await seatedTable();
  assert.equal(table.status, 'playing', '1回目で配れている');

  const again = await pressPk(`pk:start:${table.id}`, { userId: 'u1' });
  assert.equal(again.type, 6, '先に「受け取った」とだけ返す');
  assert.match(JSON.stringify(lastBoard()), /札の交換/, 'いまの場面に追いつく');
  assert.doesNotMatch(JSON.stringify(lastBoard()), /始められませんでした/);

  // 座り直そうとしても同じく追いつくだけで、席は増えない
  const late = await pressPk(`pk:join:${table.id}`, { userId: 'u7' });
  assert.equal(late.type, 7);
  assert.match(screenText(late), /札の交換/);
  assert.equal(lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).players.length, 4);
});

await test('勝負の場面で押し直しても、その場面に追いつく', async () => {
  const { table } = await toBetPhase(200);
  await pressPk(`pk:start:${table.id}`, { userId: 'u1' });
  assert.match(JSON.stringify(lastBoard()), /勝負か、降りるか/);
});

await test('配ると全員に5枚ずつ配られる', async () => {
  const table = await seatedTable();
  const state = lib.stateOf(table);
  assert.equal(state.phase, 'draw');
  assert.equal(state.players.length, 4);
  for (const player of state.players) {
    assert.equal(player.cards.length, 5, '5枚配る');
    assert.deepEqual(player.keep, [true, true, true, true, true], '最初は全部残す');
    assert.equal(player.draws, 0);
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

  assert.equal(after.draws, 1);
  assert.equal(after.exchanged, false, 'まだ1回目なので続けられる');
  // 引き直すと並べ直すので、位置ではなく「その札があるか」で見る
  const key = (card) => `${card.suit}-${card.rank}`;
  const kept = new Set(after.cards.map(key));
  for (const card of before.slice(2)) assert.ok(kept.has(key(card)), '残した3枚はそのまま');
  assert.ok(!before.slice(0, 2).every((card) => kept.has(key(card))), '捨てた2枚は引き直される');
  assert.deepEqual(after.keep, [true, true, true, true, true], '次の交換に向けて選び直せる');
});

await test('手札は右へいくほど小さい順に並ぶ', async () => {
  const table = await seatedTable();
  const weight = (card) => (card.rank === 1 ? 14 : card.rank);
  for (const player of lib.stateOf(table).players) {
    const order = player.cards.map(weight);
    assert.deepEqual(order, [...order].sort((a, b) => b - a), `並んでいない: ${order.join(',')}`);
  }

  // 引き直したあとも並べ直す
  for (let index = 0; index < 5; index++) await pressPk(`pk:keep:${table.id}:${index}`, { userId: 'u1' });
  await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  const after = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1').cards;
  const order = after.map(weight);
  assert.deepEqual(order, [...order].sort((a, b) => b - a), '引き直したあとも並んでいる');
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

await test('交換は1人2回まで', async () => {
  const table = await seatedTable();
  const swapOnce = async () => {
    await pressPk(`pk:keep:${table.id}:0`, { userId: 'u1' });
    await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  };
  await swapOnce();
  await swapOnce();

  const after = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1');
  assert.equal(after.draws, 2);
  assert.equal(after.exchanged, true, '2回替えたら終わり');

  const late = await pressPk(`pk:keep:${table.id}:0`, { userId: 'u1' });
  assert.match(screenText(late), /もう交換は終わって/);
  const again = await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  assert.match(screenText(again), /もう交換は終わって/);
});

await test('捨てる札を選ばずに交換は押せない', async () => {
  const table = await seatedTable();
  const nothing = await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  assert.match(screenText(nothing), /捨てる札を選んで/);
  const still = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1');
  assert.equal(still.draws, 0, '引き直していない');
});

await test('「これで勝負へ」で1回目の途中でも打ち切れる', async () => {
  const table = await seatedTable();
  const before = lib.stateOf(table).players.find((player) => player.userId === 'u1').cards;
  await pressPk(`pk:stand:${table.id}`, { userId: 'u1' });

  const after = lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id))
    .players.find((player) => player.userId === 'u1');
  assert.equal(after.exchanged, true);
  assert.equal(after.draws, 0, '引き直していない');
  assert.deepEqual(after.cards, before, '手札はそのまま');
});

await test('全員が交換し終わると勝負の場面に進む', async () => {
  const table = await seatedTable();
  for (const userId of SEATS.slice(0, 3)) {
    await pressPk(`pk:stand:${table.id}`, { userId });
    const mid = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
    assert.equal(mid.phase, 'draw', 'まだ全員終わっていない');
  }
  await pressPk(`pk:stand:${table.id}`, { userId: 'u4' });
  const after = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.equal(after.phase, 'bet');
});

await test('1回だけ替えてやめた人がいても先へ進む', async () => {
  const table = await seatedTable();
  await pressPk(`pk:keep:${table.id}:0`, { userId: 'u1' });
  await pressPk(`pk:swap:${table.id}`, { userId: 'u1' });
  await pressPk(`pk:stand:${table.id}`, { userId: 'u1' });
  for (const userId of SEATS.slice(1)) await pressPk(`pk:stand:${table.id}`, { userId });
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
  for (const userId of SEATS) await pressPk(`pk:stand:${table.id}`, { userId });
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

/* ------------------------------------------------------------------ レイズ */

section('レイズ');

/** レイズのボタンを押す（半額 half / 同額 same）。 */
const raise = (table, userId, kind = 'same') => pressPk(`pk:raise:${table.id}:${kind}`, { userId });

const seatOf = async (tableId, userId) =>
  lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', tableId))
    .players.find((player) => player.userId === userId);

await test('レイズすると、残り全員からもその場で預かる', async () => {
  const { table } = await toBetPhase(200);
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);

  await raise(table, 'u1', 'same');

  // レイズした本人は参加費ぶん＋上乗せぶんを場に出す
  const me = await seatOf(table.id, 'u1');
  assert.equal(me.paid, 400, '200(コール)＋200(レイズ)');
  assert.equal(me.escrow, 0);
  assert.equal(me.called, true);
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), before.u1 - 400);

  // ほかの人は「預かっただけ」。まだ場には出ていない
  for (const userId of SEATS.slice(1)) {
    const player = await seatOf(table.id, userId);
    assert.equal(player.escrow, 400, `${userId} から預かっている`);
    assert.equal(player.paid, 0, 'まだ場には出していない');
    assert.equal(player.called, false, '決め直しになる');
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId] - 400, '財布からは引かれている');
  }
});

await test('レイズされたあと降りると、預かったぶんだけ返る', async () => {
  const { table } = await toBetPhase(200);
  await raise(table, 'u1', 'same');
  const before = await eco.getBalance(db, GUILD, 'u2');

  await pressPk(`pk:fold:${table.id}`, { userId: 'u2' });
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), before + 400, '預かった400が返る');

  const folded = await seatOf(table.id, 'u2');
  assert.equal(folded.folded, true);
  assert.equal(folded.escrow, 0);
  assert.equal(folded.staked, 200, '参加費は場に残る');
});

await test('一度コールしてからレイズされた人は、差額だけ預けられる', async () => {
  const { table } = await toBetPhase(200);
  await pressPk(`pk:call:${table.id}`, { userId: 'u2' });
  const afterCall = await eco.getBalance(db, GUILD, 'u2');

  await raise(table, 'u1', 'same');
  const player = await seatOf(table.id, 'u2');
  assert.equal(player.paid, 200, 'コールぶんは場に出たまま');
  assert.equal(player.escrow, 200, '差額だけ預かる');
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), afterCall - 200);

  // ここで降りると、返るのは差額だけ。コールぶんは戻らない
  const beforeFold = await eco.getBalance(db, GUILD, 'u2');
  await pressPk(`pk:fold:${table.id}`, { userId: 'u2' });
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), beforeFold + 200);
  assert.equal((await seatOf(table.id, 'u2')).staked, 400, '参加費＋コールぶんは場に残る');
});

await test('ついていくと、預かったぶんが場に移る（二重取りしない）', async () => {
  const { table } = await toBetPhase(200);
  await raise(table, 'u1', 'same');
  const before = await eco.getBalance(db, GUILD, 'u2');

  await pressPk(`pk:call:${table.id}`, { userId: 'u2' });
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), before, '預かり済みなので追加では引かれない');

  const player = await seatOf(table.id, 'u2');
  assert.equal(player.escrow, 0);
  assert.equal(player.paid, 400);
  assert.equal(player.staked, 600, '参加費200＋400');
  assert.equal(player.called, true);
});

await test('半額のレイズも選べる', async () => {
  const { table } = await toBetPhase(200);
  await raise(table, 'u1', 'half');
  const me = await seatOf(table.id, 'u1');
  assert.equal(me.paid, 300, '200(コール)＋100(半額)');
  assert.equal((await seatOf(table.id, 'u2')).escrow, 300);
});

await test('好きな額をフォームから入れられる', async () => {
  const { table } = await toBetPhase(200);
  const form = await pressPk(`pk:raiseform:${table.id}`, { userId: 'u1' });
  assert.equal(form.type, 9, '入力フォームが開く');
  assert.equal(form.data.custom_id, `pk:raisedo:${table.id}`);

  await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: '55' } });
  assert.equal((await seatOf(table.id, 'u1')).paid, 255, '200＋55');
  assert.equal((await seatOf(table.id, 'u2')).escrow, 255);
});

await test('数字でない額は弾く', async () => {
  const { table } = await toBetPhase(200);
  const bad = await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: 'たくさん' } });
  assert.match(screenText(bad), /1以上の整数/);
  assert.equal((await seatOf(table.id, 'u1')).paid, 0, '何も起きていない');
});

await test('再レイズはできない', async () => {
  const { table } = await toBetPhase(200);
  await raise(table, 'u1', 'same');
  const again = await raise(table, 'u2', 'same');
  assert.match(screenText(again), /再レイズはできません|もう誰かがレイズ/);
  assert.equal((await seatOf(table.id, 'u2')).escrow, 400, '預かりは動かない');
});

await test('卓の誰かが払えない額までは上げられない', async () => {
  const { table } = await toBetPhase(200);
  // u3 の財布を薄くする。u3 が払える上限までしか上げられないはず
  await eco.setBalance(db, GUILD, 'u3', 250, 'test');

  await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: '9999' } });
  const level = lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).level;
  assert.equal(level, 250, 'u3 の全財産までに下がる');
  assert.equal((await seatOf(table.id, 'u3')).escrow, 250);
  assert.equal(await eco.getBalance(db, GUILD, 'u3'), 0, 'ちょうど払い切れる');
});

await test('全員が払えないなら上げられず、財布も動かない', async () => {
  const { table } = await toBetPhase(200);
  await eco.setBalance(db, GUILD, 'u3', 0, 'test');
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);

  const denied = await raise(table, 'u1', 'same');
  assert.match(screenText(denied), /上げられません/);
  for (const userId of SEATS) {
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId], `${userId} の財布は動かない`);
  }
  assert.equal(lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).level, 200);
});

await test('集めているあいだに誰かが降りたら、レイズを中止して全額返す', async () => {
  const { table, startTotal } = await toBetPhase(200);
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);

  // レイズは「先に全員から集めて、そのあと記録する」順番。
  // その隙に u2 が降りた状況を、1人目の引き落としに割り込んで作る。
  // 集めた額の行き先が無くなるので、レイズは中止されないといけない
  const realRun = db.run.bind(db);
  let injected = false;
  db.run = async (sql, ...params) => {
    const result = await realRun(sql, ...params);
    if (!injected && /UPDATE balances/.test(sql)) {
      injected = true;
      const row = await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id);
      await realRun(
        'UPDATE poker_tables SET state = ?2, version = version + 1 WHERE id = ?1',
        table.id,
        JSON.stringify(lib.foldPlayer(JSON.parse(row.state), 'u2')),
      );
    }
    return result;
  };

  let denied;
  try {
    denied = await raise(table, 'u1', 'same');
  } finally {
    db.run = realRun;
  }

  assert.ok(injected, '割り込みが実際に起きた');
  // 中止されずに通ってしまうと、降りた u2 から集めた額が行き場を失って消える
  assert.equal(await totalCoins(), startTotal - 800, 'レイズが中止されず、財布から集めたままになっている');
  for (const userId of SEATS) {
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId], `${userId} の財布が元に戻っていない`);
  }
  assert.equal(lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).level, 200, '上がっていない');
  assert.match(screenText(denied), /先に動きました/);
});

await test('レイズを挟んでもコインの総量は変わらない', async () => {
  const { table, startTotal } = await toBetPhase(200);
  await raise(table, 'u1', 'same');
  await pressPk(`pk:call:${table.id}`, { userId: 'u2' });
  await pressPk(`pk:fold:${table.id}`, { userId: 'u3' });
  await pressPk(`pk:call:${table.id}`, { userId: 'u4' });
  await ctx.settle();

  const finished = await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id);
  assert.equal(finished.status, 'done', '全員決まったら決着する');
  assert.equal(await totalCoins(), startTotal, 'コインが湧いたり消えたりしない');
});

await test('レイズの途中で時間切れになっても、預かったぶんまで返る', async () => {
  const { table, startTotal } = await toBetPhase(200);
  await raise(table, 'u1', 'same');

  await db.run('UPDATE poker_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await board.timeOut(ctx, await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.equal(await totalCoins(), startTotal, '場のぶんも預かりぶんも全部返る');
});

await test('レイズされたら掲示も手札も決め直しの形になる', async () => {
  const { table } = await toBetPhase(200);
  await raise(table, 'u1', 'same');

  const board2 = JSON.stringify(ctx.edited.at(-1).payload);
  assert.match(board2, /レイズされた/);

  const mine = await pressPk(`pk:hand:${table.id}`, { userId: 'u2' });
  assert.match(screenText(mine), /預かっています/);
  const ids = customIds(mine);
  assert.ok(ids.includes(`pk:call:${table.id}`), 'ついていくボタン');
  assert.ok(ids.includes(`pk:fold:${table.id}`), '降りるボタン');
  assert.ok(!ids.some((id) => id.startsWith(`pk:raise`)), '再レイズのボタンは出さない');
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
