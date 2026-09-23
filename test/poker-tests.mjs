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
  assert.match(JSON.stringify(lastBoard()), /簡ポーカー　勝負/);
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

/** レイズを提案する（半額 half / 同額 same）。 */
const propose = (table, userId, kind = 'same') => pressPk(`pk:raise:${table.id}:${kind}`, { userId });

const seatOf = async (tableId, userId) =>
  lib
    .stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', tableId))
    .players.find((player) => player.userId === userId);

const stateNow = async (tableId) =>
  lib.stateOf(await db.get('SELECT * FROM poker_tables WHERE id = ?1', tableId));

await test('誰も提案しなければ、1周で役比べになる', async () => {
  const { table, startTotal } = await toBetPhase(200);
  assert.equal((await stateNow(table.id)).step, 'propose', '1周目は提案の周');

  for (const userId of SEATS) await pressPk(`pk:call:${table.id}`, { userId });
  await ctx.settle();

  assert.equal((await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).status, 'done');
  assert.equal(await totalCoins(), startTotal, 'コインは湧かない');
});

await test('提案した人だけが払う。ほかの人の財布は動かない', async () => {
  const { table } = await toBetPhase(200);
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);

  await propose(table, 'u1', 'same');

  // 提案した人は「まだ出していない200」＋「上乗せ200」を払う
  const me = await seatOf(table.id, 'u1');
  assert.equal(me.paid, 400);
  assert.equal(me.proposal, 200);
  assert.equal(me.acted, true);
  assert.equal(await eco.getBalance(db, GUILD, 'u1'), before.u1 - 400);

  // ほかの人はまだ1円も動いていない
  for (const userId of SEATS.slice(1)) {
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId], `${userId} の財布は動かない`);
    assert.equal((await seatOf(table.id, userId)).paid, 0);
  }
  assert.equal((await stateNow(table.id)).step, 'propose', 'まだ提案の周（全員が動くまで閉じない）');
});

await test('一番高い提案が通り、承認の周に移る', async () => {
  const { table } = await toBetPhase(200);
  await propose(table, 'u1', 'half'); // +100
  await propose(table, 'u2', 'same'); // +200 ← こちらが通る
  await pressPk(`pk:call:${table.id}`, { userId: 'u3' });
  await pressPk(`pk:call:${table.id}`, { userId: 'u4' });

  const state = await stateNow(table.id);
  assert.equal(state.step, 'accept');
  assert.equal(state.lastRaise, 200, '高いほうが通る');
  assert.equal(state.level, 400, '200 ＋ 200');

  // 一番高く出した人はもう払い終わっている
  assert.equal(lib.owedBy(state, state.players.find((p) => p.userId === 'u2')), 0);
  // 低く出した人は差額だけ追加で要る
  assert.equal(lib.owedBy(state, state.players.find((p) => p.userId === 'u1')), 100);
  // 乗っただけの人は上乗せぶん全部
  assert.equal(lib.owedBy(state, state.players.find((p) => p.userId === 'u3')), 200);
});

await test('承認すると払い、降りると払わない', async () => {
  const { table } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  assert.equal((await stateNow(table.id)).step, 'accept');

  const beforeYes = await eco.getBalance(db, GUILD, 'u2');
  await pressPk(`pk:call:${table.id}`, { userId: 'u2' });
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), beforeYes - 200, '承認したぶんだけ引かれる');
  assert.equal(lib.owedBy(await stateNow(table.id), await seatOf(table.id, 'u2')), 0);

  const beforeNo = await eco.getBalance(db, GUILD, 'u3');
  await pressPk(`pk:fold:${table.id}`, { userId: 'u3' });
  assert.equal(await eco.getBalance(db, GUILD, 'u3'), beforeNo, '降りれば払わない');
  assert.equal((await seatOf(table.id, 'u3')).staked, 400, 'すでに出したぶんは場に残る');
});

await test('承認の周が終わると、また提案の周に戻る（何度でも上げられる）', async () => {
  const { table } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });

  const back = await stateNow(table.id);
  assert.equal(back.step, 'propose', '提案の周に戻る');
  assert.equal(back.level, 400);
  for (const player of back.players) {
    assert.equal(player.acted, false, '全員またゼロから');
    assert.equal(player.proposal, 0);
  }

  // 2回目のレイズも通る
  await propose(table, 'u2', 'same');
  for (const userId of ['u1', 'u3', 'u4']) await pressPk(`pk:call:${table.id}`, { userId });
  const second = await stateNow(table.id);
  assert.equal(second.step, 'accept');
  assert.equal(second.level, 600, '400 ＋ 200');
});

await test('提案の周で出すものが無ければ「このまま」だけで進む', async () => {
  const { table, startTotal } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });

  // 全員がもう level まで出しているので、押しても財布は動かない
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);
  for (const userId of SEATS.slice(0, 3)) await pressPk(`pk:call:${table.id}`, { userId });
  for (const userId of SEATS.slice(0, 3)) {
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId], `${userId} から追加で引かれない`);
  }

  // 最後の1人が押すと、誰も提案していないので役比べへ
  await pressPk(`pk:call:${table.id}`, { userId: 'u4' });
  await ctx.settle();
  assert.equal((await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).status, 'done');
  assert.equal(await totalCoins(), startTotal, 'コインの総量は変わらない');
});

await test('承認の周ではレイズを提案できない', async () => {
  const { table } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  assert.equal((await stateNow(table.id)).step, 'accept');

  const denied = await propose(table, 'u2', 'same');
  assert.match(screenText(denied), /承認するか降りるか/);
  assert.equal((await stateNow(table.id)).level, 400, '上がっていない');
});

await test('同じ周に2回は動けない', async () => {
  const { table } = await toBetPhase(200);
  await pressPk(`pk:call:${table.id}`, { userId: 'u1' });
  const again = await propose(table, 'u1', 'same');
  assert.match(screenText(again), /この周はもう動いています/);
  assert.equal((await seatOf(table.id, 'u1')).proposal, 0);
});

await test('好きな額をフォームから提案できる', async () => {
  const { table } = await toBetPhase(200);
  const form = await pressPk(`pk:raiseform:${table.id}`, { userId: 'u1' });
  assert.equal(form.type, 9, '入力フォームが開く');
  assert.equal(form.data.custom_id, `pk:raisedo:${table.id}`);

  await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: '55' } });
  assert.equal((await seatOf(table.id, 'u1')).proposal, 55);
  assert.equal((await seatOf(table.id, 'u1')).paid, 255, '200 ＋ 55');
});

await test('数字でない額は弾く', async () => {
  const { table } = await toBetPhase(200);
  const bad = await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: 'たくさん' } });
  assert.match(screenText(bad), /1以上の整数/);
  assert.equal((await seatOf(table.id, 'u1')).paid, 0, '何も起きていない');
});

await test('上限は、残っている中で一番払えない人に合わせる', async () => {
  const { table } = await toBetPhase(200);
  await eco.setBalance(db, GUILD, 'u3', 250, 'test'); // 200(乗る) ＋ 50 が限界

  await pressPk(`pk:raisedo:${table.id}`, { userId: 'u1', type: 5, fields: { amount: '9999' } });
  assert.equal((await seatOf(table.id, 'u1')).proposal, 50, 'u3 が払える 50 まで下がる');

  // その 50 は u3 もちゃんと承認できる
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  assert.equal((await stateNow(table.id)).step, 'accept');
  await pressPk(`pk:call:${table.id}`, { userId: 'u3' });
  assert.equal(await eco.getBalance(db, GUILD, 'u3'), 0, 'ちょうど払い切れる');
  assert.equal(lib.owedBy(await stateNow(table.id), await seatOf(table.id, 'u3')), 0);
});

await test('全員が払えないなら提案できず、財布も動かない', async () => {
  const { table } = await toBetPhase(200);
  await eco.setBalance(db, GUILD, 'u3', 200, 'test'); // 乗るだけで精一杯
  const before = {};
  for (const userId of SEATS) before[userId] = await eco.getBalance(db, GUILD, userId);

  const denied = await propose(table, 'u1', 'same');
  assert.match(screenText(denied), /上げられません/);
  for (const userId of SEATS) {
    assert.equal(await eco.getBalance(db, GUILD, userId), before[userId], `${userId} の財布は動かない`);
  }
});

await test('提案から承認までに払えなくなっていたら強制で降りる', async () => {
  const { table } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  assert.equal((await stateNow(table.id)).step, 'accept');

  // 承認する前に、別のゲームで使い切ってしまった状況
  await eco.setBalance(db, GUILD, 'u2', 0, 'test');
  const kicked = await pressPk(`pk:call:${table.id}`, { userId: 'u2' });
  assert.match(screenText(kicked), /払えなくなっていたので降りました/);

  const player = await seatOf(table.id, 'u2');
  assert.equal(player.folded, true);
  assert.equal(await eco.getBalance(db, GUILD, 'u2'), 0, 'マイナスにはならない');
});

await test('レイズを2回挟んでもコインの総量は変わらない', async () => {
  const { table, startTotal } = await toBetPhase(200);

  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });

  await propose(table, 'u2', 'half');
  await pressPk(`pk:call:${table.id}`, { userId: 'u1' });
  await pressPk(`pk:fold:${table.id}`, { userId: 'u3' });
  await pressPk(`pk:call:${table.id}`, { userId: 'u4' });
  for (const userId of ['u1', 'u4']) await pressPk(`pk:call:${table.id}`, { userId });
  for (const userId of ['u1', 'u2', 'u4']) await pressPk(`pk:call:${table.id}`, { userId });
  await ctx.settle();

  assert.equal((await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).status, 'done');
  assert.equal(await totalCoins(), startTotal, 'コインが湧いたり消えたりしない');
});

await test('レイズの途中で時間切れになっても全額返る', async () => {
  const { table, startTotal } = await toBetPhase(200);
  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });
  await pressPk(`pk:call:${table.id}`, { userId: 'u2' });

  await db.run('UPDATE poker_tables SET expires_at = 1 WHERE id = ?1', table.id);
  await board.timeOut(ctx, await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id));
  assert.equal(await totalCoins(), startTotal, '出したぶんが全部返る');
});

await test('3人降りたら、4人目は押さなくても総取りになる', async () => {
  const { table, startTotal } = await toBetPhase(200);
  for (const userId of ['u1', 'u2', 'u3']) await pressPk(`pk:fold:${table.id}`, { userId });
  await ctx.settle();

  assert.equal((await db.get('SELECT * FROM poker_tables WHERE id = ?1', table.id)).status, 'done');
  assert.match(JSON.stringify(ctx.edited.at(-1).payload), /ひとり残って/);
  assert.equal(await totalCoins(), startTotal, 'コインは湧かない');
});

await test('画面がいまの周に合った形になる', async () => {
  const { table } = await toBetPhase(200);
  const first = await pressPk(`pk:hand:${table.id}`, { userId: 'u1' });
  const firstIds = customIds(first);
  assert.ok(firstIds.includes(`pk:call:${table.id}`), '乗るボタン');
  assert.ok(firstIds.some((id) => id.startsWith('pk:raise')), '1周目からレイズを提案できる');

  await propose(table, 'u1', 'same');
  for (const userId of SEATS.slice(1)) await pressPk(`pk:call:${table.id}`, { userId });

  assert.match(JSON.stringify(ctx.edited.at(-1).payload), /レイズが出た/, '掲示が承認の周になる');
  const accepting = await pressPk(`pk:hand:${table.id}`, { userId: 'u2' });
  assert.match(screenText(accepting), /承認するなら/);
  const ids = customIds(accepting);
  assert.ok(ids.includes(`pk:call:${table.id}`) && ids.includes(`pk:fold:${table.id}`));
  assert.ok(!ids.some((id) => id.startsWith('pk:raise')), '承認の周ではレイズのボタンを出さない');
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
