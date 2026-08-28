// メニュー（ボタン・セレクト・入力フォーム）の画面遷移を、Discord に接続せずに検証する。
//   1. 画面に置いたボタンがすべて実在するハンドラに届くか（押しても無反応なボタンが無いか）
//   2. 実際の操作でコイン・アイテムが正しく動くか
//   3. 権限のない人が管理操作をできないか
import assert from 'node:assert/strict';
import {
  createRunner,
  createTestContext,
  customIds,
  finalFrame,
  firstEmbed,
  rawInteraction,
  screenText,
  src,
} from './harness.mjs';

const { screens, handleComponent, findHandler } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));
const { findCommand, COMMAND_DEFINITIONS } = await import(src('commands.js'));
const eco = await import(src('lib/economy.js'));
const streakLib = await import(src('lib/streak.js'));
const achLib = await import(src('lib/achievements.js'));
const annLib = await import(src('lib/announcements.js'));
const act = await import(src('lib/activities.js'));
const shop = await import(src('lib/shop.js'));

const runner = createRunner('[メニュー]');
const { test, section } = runner;
const ctx = createTestContext();
const db = ctx.db;

const GUILD = 'g1';
const ME = 'u1';
const OTHER = 'u2';

async function press(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

async function runCommand(name, options = {}) {
  const ix = new Ix(rawInteraction({ type: 2, commandName: name, fromMessage: false, ...options }));
  const response = await findCommand(name)(ix, ctx);
  await ctx.settle();
  return response.json();
}

function resolves(customId) {
  return Boolean(findHandler(customId));
}

function assertAllButtonsWork(payload, label) {
  for (const customId of customIds(payload)) {
    assert.ok(resolves(customId), `${label} の中に届かないボタン: ${customId}`);
  }
}

/**
 * 画面のボタンを実際に押して、入力の読み違いで怒られないことを確かめる。
 * 「宛先が存在するか」だけでは、別の操作に届いてしまう間違いを見逃すため。
 */
async function assertNoButtonComplains(payload, label, options = {}) {
  for (const customId of customIds(payload)) {
    const result = await press(customId, options);
    const text = screenText(result);
    assert.ok(
      !/⚠️[^"]*(整数|数字|読めませんでした)/.test(text),
      `${label} の「${customId}」を押すと入力の読み違いで怒られる: ${text.slice(0, 160)}`,
    );
  }
}

// 下ごしらえ
await eco.setBalance(db, GUILD, ME, 5000, 'test');
await eco.setBalance(db, GUILD, OTHER, 500, 'test');
for (const preset of act.PRESET_ACTIVITIES) await act.upsertActivity(db, GUILD, preset);
const item = await shop.createItem(db, { guildId: GUILD, sellerId: OTHER, name: 'テスト商品', price: 300, stock: 5 });
const myItem = await shop.createItem(db, { guildId: GUILD, sellerId: ME, name: '自分の商品', price: 100, stock: -1 });

section('[入口]');

await test('/menu でメニューが開く', async () => {
  const payload = await runCommand('menu');
  assert.equal(payload.type, 4, '新しいメッセージとして返す');
  assert.equal(payload.data.flags, 64, '本人にだけ見える');
  assert.match(firstEmbed(payload).title, /メニュー/);
  assertAllButtonsWork(payload, '/menu');
});

await test('/help が使い方を出す', async () => {
  const payload = await runCommand('help');
  assert.match(firstEmbed(payload).title, /遊び方/);
});

await test('登録するコマンドはサーバー内限定', () => {
  assert.deepEqual(COMMAND_DEFINITIONS.map((c) => c.name).sort(), ['help', 'menu']);
  for (const command of COMMAND_DEFINITIONS) assert.deepEqual(command.contexts, [0]);
});

section('[画面遷移]');

await test('ボタンを押すとメッセージが書き換わる', async () => {
  const payload = await press('m:home:open');
  assert.equal(payload.type, 7, '元のメッセージを更新する');
});

await test('管理者だけに管理ボタンが出る', async () => {
  const normal = await press('m:home:open', { admin: false });
  const manager = await press('m:home:open', { admin: true });
  assert.ok(!customIds(normal).includes('m:admin:open'));
  assert.ok(customIds(manager).includes('m:admin:open'));
});

await test('主要画面のボタンがすべて生きている', async () => {
  const entries = [
    ['m:home:open'], ['m:home:help'], ['m:report:open'], ['m:report:stats'], ['m:games:open'],
    ['m:slot:open'], ['m:cf:open'], ['m:rps:open'], ['m:shop:open'], ['m:shop:mine'],
    ['m:shop:inventory'], ['m:wallet:open'], ['m:wallet:pay'], ['m:wallet:history'], ['m:wallet:rank'],
    ['m:admin:open', { admin: true }], ['m:admin:acts', { admin: true }], ['m:admin:bal', { admin: true }],
  ];
  for (const [customId, options] of entries) {
    const payload = await press(customId, options ?? {});
    assert.ok(payload.data, `${customId} が何も返さなかった`);
    assertAllButtonsWork(payload, customId);
  }
});

await test('未知のボタンでもメニューに戻すだけで落ちない', async () => {
  const payload = await press('m:nowhere:nothing');
  assert.match(screenText(payload), /メニュー/);
});

section('[報告]');

await test('選ぶだけで報告が成立し、チャンネルにも投稿される', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const activity = await act.getActivity(db, GUILD, '早起き');
  const sentBefore = ctx.sent.length;
  const payload = await press('m:report:pick', { values: ['早起き'] });
  assert.equal(await eco.getBalance(db, GUILD, ME), before + activity.reward);
  assert.equal(ctx.sent.length, sentBefore + 1, '公開投稿が1件');
  assert.match(firstEmbed(payload).title, /早起き/);
});

await test('1日の上限に達すると理由が画面に出て残高が動かない', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:report:pick', { values: ['早起き'] });
  assert.equal(await eco.getBalance(db, GUILD, ME), before);
  assert.match(firstEmbed(payload).description, /1日|休憩/);
});

await test('消えたアクションを選んでも落ちない', async () => {
  const payload = await press('m:report:pick', { values: ['存在しない'] });
  assert.match(firstEmbed(payload).description, /削除/);
});

section('[ゲーム]');

await test('スロットはまず回転中を出し、少しずつ結果が現れる', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const first = await press('m:slot:bet:100');
  const after = await eco.getBalance(db, GUILD, ME);

  assert.match(firstEmbed(first).description, /回転中/, '押した直後は回転中');
  assert.deepEqual(first.data.components, [], '回っているあいだはボタンを出さない');
  assert.ok(after <= before + 300000 && after >= before - 100, 'お金の処理は先に済んでいる');

  assert.equal(ctx.animated.length, 3, 'リールが1つずつ止まる');
  assert.match(ctx.animated[0].embeds[0].description, /回転中/);
  const last = finalFrame(ctx);
  assert.match(last.embeds[0].description, /🍒|🍋|🍇|🔔|⭐|7️⃣|💎/);
  assertAllButtonsWork({ data: last }, 'スロット結果');
});

await test('所持金を超える賭け金は弾かれる', async () => {
  await eco.setBalance(db, GUILD, ME, 50, 'test');
  const payload = await press('m:slot:bet:1000');
  assert.equal(await eco.getBalance(db, GUILD, ME), 50);
  assert.match(firstEmbed(payload).description, /残高|上限/);
  await eco.setBalance(db, GUILD, ME, 5000, 'test');
});

await test('「金額を入力」を押すと入力フォームが開く', async () => {
  for (const [screen, options] of [
    ['m:slot:open', {}],
    ['m:cf:open', {}],
  ]) {
    const payload = await press(screen, options);
    const customId = customIds(payload).find((id) => id.endsWith(':custom'));
    assert.ok(customId, `${screen} に金額入力のボタンがある`);
    const opened = await press(customId, options);
    assert.equal(opened.type, 9, `${customId} は入力フォームを開く`);
    assert.match(opened.data.components[0].components[0].custom_id, /amount/);
  }

  // じゃんけんは相手を選んでからなので別扱い
  const rps = await press('m:rps:user', { values: [OTHER] });
  const rpsCustom = customIds(rps).find((id) => id.includes(':custom:'));
  assert.ok(rpsCustom, 'じゃんけんにも金額入力のボタンがある');
  assert.equal((await press(rpsCustom)).type, 9);
});

await test('ゲーム画面のボタンはどれも入力の読み違いで怒られない', async () => {
  await eco.setBalance(db, GUILD, ME, 5000, 'test');
  for (const screen of ['m:slot:open', 'm:cf:open', 'm:games:open']) {
    await assertNoButtonComplains(await press(screen), screen);
  }
});

await test('入力フォームの金額（全角も可）でスロットが回る', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:slot:amount', { type: 5, fields: { amount: '２００' } });
  assert.match(firstEmbed(payload).description, /回転中/);
  assert.notEqual(await eco.getBalance(db, GUILD, ME), before);
});

await test('数字でない入力は弾かれる', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:slot:amount', { type: 5, fields: { amount: 'いっぱい' } });
  assert.equal(await eco.getBalance(db, GUILD, ME), before);
  assert.match(firstEmbed(payload).description, /数字/);
});

await test('コイントスは表裏を選んでから勝負し、結果は少し待って出る', async () => {
  const payload = await press('m:cf:bet:100');
  const ids = customIds(payload);
  assert.ok(ids.includes('m:cf:go:100:heads') && ids.includes('m:cf:go:100:tails'));

  const before = await eco.getBalance(db, GUILD, ME);
  const tossing = await press('m:cf:go:100:heads');
  const after = await eco.getBalance(db, GUILD, ME);

  assert.match(firstEmbed(tossing).description, /弾きました/, '押した直後は投げただけ');
  assert.ok(after === before + 100 || after === before - 100, `${before} → ${after}`);

  const last = finalFrame(ctx);
  assert.match(last.embeds[0].description, /結果は/);
  assertAllButtonsWork({ data: last }, 'コイントス結果');
});

await test('じゃんけんの挑戦状がチャンネルに投稿される', async () => {
  const sentBefore = ctx.sent.length;
  const payload = await press('m:rps:go:u2:100');
  assert.equal(ctx.sent.length, sentBefore + 1);
  assert.match(firstEmbed(payload).title, /挑戦状/);
  const match = await db.get("SELECT * FROM rps_matches WHERE guild_id = ?1 AND status = 'pending'", GUILD);
  assert.equal(match.opponent_id, OTHER);
  assert.equal(match.bet, 100);
  assert.ok(match.message_id, 'あとで書き換えられるようメッセージIDを覚える');
});

await test('自分自身には挑戦できない', async () => {
  const payload = await press('m:rps:user', { values: [ME] });
  assert.match(firstEmbed(payload).description, /自分自身/);
});

section('[ハイ&ロー]');

await test('賭けると場が始まり、上か下かを選べる', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  const payload = await press('m:hl:bet:100');
  assert.equal(await eco.getBalance(db, GUILD, ME), 900, '賭け金が引かれる');
  const ids = customIds(payload);
  assert.ok(ids.includes('m:hl:pick:high') && ids.includes('m:hl:pick:low'));
  assertAllButtonsWork(payload, 'ハイ&ローの場');

  const game = await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
  assert.equal(game.bet, 100);
  assert.equal(game.steps, 0);
});

await test('1回も当てていないうちは降りられない', async () => {
  const payload = await press('m:hl:open');
  const stop = payload.data.components[0].components.find((c) => c.custom_id === 'm:hl:stop');
  assert.equal(stop.disabled, true);

  const tried = await press('m:hl:stop');
  assert.match(firstEmbed(tried).description, /1回も当ててから/);
  assert.ok(await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME), '勝負は続く');
});

await test('進行中は新しい勝負を始められない', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:hl:bet:100');
  assert.equal(await eco.getBalance(db, GUILD, ME), before, '二重に賭け金を取られない');
  assert.match(firstEmbed(payload).description, /すでに勝負が進んでいます|次のカード/);
});

await test('予想すると勝ち負けが決まり、外れると勝負が終わる', async () => {
  // 当たりを引くまで繰り返す（外れたら賭け直す）
  let won = false;
  for (let i = 0; i < 40 && !won; i++) {
    const game = await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
    if (!game) {
      await eco.setBalance(db, GUILD, ME, 1000, 'test');
      await press('m:hl:bet:100');
      continue;
    }
    const chance = (13 - game.card_rank) / 12;
    await press(chance >= 0.5 ? 'm:hl:pick:high' : 'm:hl:pick:low');
    const after = await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
    // 確率100%の予想（Aで HIGH）は倍率が 0.97 なので、伸びるまで続ける
    if (after && after.steps > 0 && after.multiplier > 1) won = true;
  }
  assert.ok(won, '当たれば連勝数が増えて勝負が続く');

  const game = await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
  assert.ok(game.multiplier > 1, '倍率が伸びている');
});

await test('降りると倍率ぶんを受け取って勝負が終わる', async () => {
  const game = await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
  const before = await eco.getBalance(db, GUILD, ME);
  const expected = Math.floor(game.bet * game.multiplier);

  const payload = await press('m:hl:stop');
  assert.equal(await eco.getBalance(db, GUILD, ME), before + expected);
  assert.match(firstEmbed(payload).title, /確定/);
  assert.equal(await db.get('SELECT * FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME), null);
});

await test('所持金を超える賭け金は弾かれる', async () => {
  await eco.setBalance(db, GUILD, ME, 50, 'test');
  const payload = await press('m:hl:bet:1000');
  assert.equal(await eco.getBalance(db, GUILD, ME), 50);
  assert.match(firstEmbed(payload).description, /残高|上限/);
});

section('[チンチロ]');

const chinchiroMatch = await import(src('menu/chinchiro-match.js'));
const chinchiroLib = await import(src('lib/chinchiro.js'));

async function pressCc(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await chinchiroMatch.handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

await test('賭け金の5倍を預けられないと挑戦できない', async () => {
  await eco.setBalance(db, GUILD, ME, 400, 'test');
  const payload = await press(`m:cc:go:${OTHER}:100`);
  assert.match(firstEmbed(payload).description, /預ける必要があります/);
  assert.equal((await db.all("SELECT id FROM chinchiro_matches WHERE status = 'pending'")).length, 0);
});

await test('挑戦状が投稿され、承諾で両者から預かる', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const sentBefore = ctx.sent.length;
  const payload = await press(`m:cc:go:${OTHER}:100`);
  assert.equal(ctx.sent.length, sentBefore + 1);
  assert.match(firstEmbed(payload).title, /挑戦状/);

  const match = await db.get("SELECT * FROM chinchiro_matches WHERE status = 'pending' ORDER BY created_at DESC");
  assert.equal(match.escrow, 500);

  await pressCc(`cc:accept:${match.id}`, { userId: OTHER });
  assert.equal(await eco.getBalance(db, GUILD, ME), 500, '挑戦者から預かる');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 500, '相手からも預かる');
  const playing = await db.get('SELECT * FROM chinchiro_matches WHERE id = ?1', match.id);
  assert.equal(playing.status, 'playing');
  assert.equal(playing.turn, 'challenger', '挑戦者から振る');
  globalThis.__ccId = match.id;
});

await test('手番でない人は振れない', async () => {
  const payload = await pressCc(`cc:roll:${globalThis.__ccId}`, { userId: OTHER });
  assert.match(screenText(payload), /あなたの番ではありません/);
  const payload2 = await pressCc(`cc:roll:${globalThis.__ccId}`, { userId: 'u9' });
  assert.match(screenText(payload2), /参加者ではありません/);
});

await test('順番に振ると決着し、コインの総量は変わらない', async () => {
  const totalBefore = (await eco.getBalance(db, GUILD, ME)) + (await eco.getBalance(db, GUILD, OTHER));

  await pressCc(`cc:roll:${globalThis.__ccId}`, { userId: ME });
  const midway = await db.get('SELECT * FROM chinchiro_matches WHERE id = ?1', globalThis.__ccId);
  assert.ok(midway.challenger_dice, '挑戦者の出目が記録される');
  assert.equal(midway.turn, 'opponent', '手番が移る');

  await pressCc(`cc:roll:${globalThis.__ccId}`, { userId: OTHER });
  const done = await db.get('SELECT * FROM chinchiro_matches WHERE id = ?1', globalThis.__ccId);
  assert.equal(done.status, 'done');

  const totalAfter = (await eco.getBalance(db, GUILD, ME)) + (await eco.getBalance(db, GUILD, OTHER));
  assert.equal(totalAfter, totalBefore + 1000, '預かった1000がすべて返っている（勝ち負けは移動のみ）');

  const me = await eco.getBalance(db, GUILD, ME);
  const other = await eco.getBalance(db, GUILD, OTHER);
  assert.ok(me >= 0 && other >= 0, 'マイナスにならない');
  assert.ok(Math.abs(me - 1000) <= 500, '動く額は預かりの範囲に収まる');
});

await test('終わった勝負のボタンはもう効かない', async () => {
  const payload = await pressCc(`cc:roll:${globalThis.__ccId}`, { userId: ME });
  assert.match(screenText(payload), /終了/);
});

await test('断ると預かりは発生しない', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  await press(`m:cc:go:${OTHER}:100`);
  const match = await db.get("SELECT * FROM chinchiro_matches WHERE status = 'pending' ORDER BY created_at DESC");
  await pressCc(`cc:decline:${match.id}`, { userId: OTHER });
  assert.equal(await eco.getBalance(db, GUILD, ME), 1000);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 1000);
  assert.equal((await db.get('SELECT * FROM chinchiro_matches WHERE id = ?1', match.id)).status, 'cancelled');
});

await test('強い役を出した方が勝ち、その人にコインが入る', async () => {
  // compare() の勝者と settle() の受取人が食い違うと、負けた側に払ってしまう。
  // 出目を固定して「誰が勝ちと表示され、誰にいくら入るか」まで確かめる。
  const settings = await ctx.settings(GUILD);

  async function playFixed(id, challengerDice, opponentDice) {
    await eco.setBalance(db, GUILD, ME, 1000, 'test');
    await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
    await chinchiroLib.createMatch(db, {
      id,
      guildId: GUILD,
      channelId: 'c1',
      challengerId: ME,
      opponentId: OTHER,
      bet: 100,
    });
    await chinchiroLib.markPlaying(db, id);
    await eco.withdraw(db, GUILD, ME, 500, 'chinchiro:escrow', id);
    await eco.withdraw(db, GUILD, OTHER, 500, 'chinchiro:escrow', id);
    await chinchiroLib.recordRoll(db, id, 'challenger', [challengerDice]);
    await chinchiroLib.recordRoll(db, id, 'opponent', [opponentDice]);

    const payload = await chinchiroMatch.resolveMatch(ctx, await chinchiroLib.getMatch(db, id), settings);
    return {
      text: payload.embeds[0].description,
      me: await eco.getBalance(db, GUILD, ME),
      other: await eco.getBalance(db, GUILD, OTHER),
    };
  }

  const pinzoro = await playFixed('ccfix1', [1, 1, 1], [2, 2, 3]);
  assert.match(pinzoro.text, new RegExp(`<@${ME}> の勝ち`), '挑戦者のピンゾロが勝ち');
  assert.equal(pinzoro.me, 1500, '×5 の 500 を受け取る');
  assert.equal(pinzoro.other, 500, '負けた側が 500 払う');

  const zorome = await playFixed('ccfix2', [2, 2, 3], [5, 5, 5]);
  assert.match(zorome.text, new RegExp(`<@${OTHER}> の勝ち`), '受け手のゾロ目が勝ち');
  assert.equal(zorome.other, 1300, '×3 の 300 を受け取る');
  assert.equal(zorome.me, 700);

  const me6 = await playFixed('ccfix3', [2, 2, 6], [3, 3, 4]);
  assert.match(me6.text, new RegExp(`<@${ME}> の勝ち`), '出目が大きい方が勝ち');
  assert.equal(me6.me, 1100);
  assert.equal(me6.other, 900);

  const hifumi = await playFixed('ccfix4', [1, 2, 3], [2, 4, 6]);
  assert.match(hifumi.text, new RegExp(`<@${OTHER}> の勝ち`), 'ヒフミを出した挑戦者の負け');
  assert.equal(hifumi.other, 1200, 'ヒフミは2倍払い');
  assert.equal(hifumi.me, 800);

  const draw = await playFixed('ccfix5', [4, 4, 2], [5, 5, 2]);
  assert.match(draw.text, /引き分け/);
  assert.equal(draw.me, 1000, '預かった分がそのまま戻る');
  assert.equal(draw.other, 1000);
});

section('[予想大会]');

const pollBoard = await import(src('menu/poll-board.js'));
const pollLib = await import(src('lib/polls.js'));

async function pressPoll(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await pollBoard.handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

await test('お題を立てるとチャンネルに投稿される', async () => {
  const sentBefore = ctx.sent.length;
  const payload = await press('m:poll:create', {
    type: 5,
    fields: { question: '今日Aは来る？', options: '来る\n来ない\n遅れて来る', minutes: '60', stake: '' },
  });
  assert.equal(ctx.sent.length, sentBefore + 1);
  assert.match(firstEmbed(payload).title, /お題を立てました/);

  const board = ctx.sent.at(-1).payload;
  assert.match(board.embeds[0].title, /今日Aは来る/);
  const ids = board.components.flatMap((row) => row.components.map((c) => c.custom_id));
  assert.equal(ids.filter((id) => id.includes(':bet:')).length, 3, '選択肢の数だけボタンが出る');

  const poll = await db.get('SELECT * FROM polls ORDER BY id DESC');
  assert.equal(poll.mode, 'free');
  assert.ok(poll.message_id, 'あとで書き換えられるようメッセージIDを覚える');
  globalThis.__pollId = poll.id;
});

await test('選択肢が少なすぎると作られない', async () => {
  const before = (await db.all('SELECT id FROM polls')).length;
  const payload = await press('m:poll:create', {
    type: 5,
    fields: { question: 'だめなお題', options: 'ひとつだけ', minutes: '60', stake: '' },
  });
  assert.match(firstEmbed(payload).description, /2 個以上/);
  assert.equal((await db.all('SELECT id FROM polls')).length, before);
});

await test('自由額なら金額の入力フォームが開き、賭けると掲示板が更新される', async () => {
  const pollId = globalThis.__pollId;
  const opened = await pressPoll(`pl:bet:${pollId}:0`, { userId: OTHER });
  assert.equal(opened.type, 9, '金額を入力する');

  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const board = await pressPoll(`pl:amount:${pollId}:0`, { type: 5, userId: OTHER, fields: { amount: '300' } });
  assert.equal(board.type, 7, '掲示板が書き換わる');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 700);
  assert.match(board.data.embeds[0].description, /300/, '集計に反映される');
});

await test('同じ人は二度賭けられない', async () => {
  const payload = await pressPoll(`pl:bet:${globalThis.__pollId}:1`, { userId: OTHER });
  assert.match(screenText(payload), /すでに参加しています/);
});

await test('数字でない金額は弾かれる', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await pressPoll(`pl:amount:${globalThis.__pollId}:1`, {
    type: 5, userId: ME, fields: { amount: 'たくさん' },
  });
  assert.match(screenText(payload), /読めませんでした/);
  assert.equal(await eco.getBalance(db, GUILD, ME), before);
});

await test('締め切れるのは出題者だけ', async () => {
  const denied = await pressPoll(`pl:close:${globalThis.__pollId}`, { userId: OTHER });
  assert.match(screenText(denied), /出題者だけ/);

  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await pressPoll(`pl:amount:${globalThis.__pollId}:1`, { type: 5, userId: ME, fields: { amount: '100' } });

  const closed = await pressPoll(`pl:close:${globalThis.__pollId}`, { userId: ME });
  assert.equal(closed.type, 7);
  assert.match(closed.data.embeds[0].description, /締め切りました/);
  const ids = closed.data.components.flatMap((row) => row.components.map((c) => c.custom_id));
  assert.ok(ids.some((id) => id.includes(':answer:')), '正解を決めるボタンが出る');
});

await test('正解を決められるのも出題者だけ', async () => {
  const denied = await pressPoll(`pl:answer:${globalThis.__pollId}`, { userId: OTHER });
  assert.match(screenText(denied), /出題者だけ/);

  const picker = await pressPoll(`pl:answer:${globalThis.__pollId}`, { userId: ME });
  const options = picker.data.components[0].components[0].options;
  assert.equal(options.length, 3);
});

await test('正解を選ぶと山分けされ、コインの総量は変わらない', async () => {
  const meBefore = await eco.getBalance(db, GUILD, ME);
  const otherBefore = await eco.getBalance(db, GUILD, OTHER);

  const result = await pressPoll(`pl:settle:${globalThis.__pollId}`, { userId: ME, values: ['0'] });
  assert.match(result.data.embeds[0].title, /今日Aは来る/);
  assert.match(result.data.embeds[0].description, /正解は/);

  // OTHER が選択肢0に300、ME が選択肢1に100 → 正解0なので OTHER が400を総取り
  assert.equal(await eco.getBalance(db, GUILD, OTHER), otherBefore + 400);
  assert.equal(await eco.getBalance(db, GUILD, ME), meBefore, '外した人は戻らない');

  const poll = await pollLib.getPollById(db, globalThis.__pollId);
  assert.equal(poll.status, 'settled');
  assert.equal(poll.answer, 0);
});

await test('終わった大会には参加できない', async () => {
  const payload = await pressPoll(`pl:bet:${globalThis.__pollId}:0`, { userId: 'u9' });
  assert.match(screenText(payload), /締め切られています/);
});

await test('選択肢は10個まで置けて、ボタンが折り返される', async () => {
  const labels = ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ'];
  await press('m:poll:create', {
    type: 5,
    fields: { question: '10択のお題', options: labels.join('\n'), minutes: '60', stake: '' },
  });

  const board = ctx.sent.at(-1).payload;
  const betRows = board.components.filter((r) => r.components.every((c) => (c.custom_id ?? '').includes(':bet:')));
  assert.equal(betRows.length, 2, '1行5つまでなので2行になる');
  assert.equal(betRows.flatMap((r) => r.components).length, 10);

  const poll = await db.get('SELECT * FROM polls ORDER BY id DESC');
  assert.equal((await pollLib.optionsOf(db, poll.id)).length, 10);
  globalThis.__poll10 = poll.id;
});

await test('出題者は賞金を上乗せでき、正解者がまとめて受け取る', async () => {
  const pollId = globalThis.__poll10;
  await eco.setBalance(db, GUILD, ME, 5000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  await eco.setBalance(db, GUILD, 'u9', 1000, 'test');

  const denied = await pressPoll(`pl:boost:${pollId}`, { userId: OTHER });
  assert.match(screenText(denied), /出題者だけ/);

  const form = await pressPoll(`pl:boost:${pollId}`, { userId: ME });
  assert.equal(form.type, 9, '金額を入力する');

  const sentBefore = ctx.sent.length;
  const board = await pressPoll(`pl:bonus:${pollId}`, { type: 5, userId: ME, fields: { amount: '1,000' } });
  assert.equal(await eco.getBalance(db, GUILD, ME), 4000, '出題者の自腹から出る');
  assert.equal((await pollLib.getPollById(db, pollId)).bonus, 1000);
  assert.match(JSON.stringify(board.data.embeds[0].fields), /上乗せ/, '掲示板に上乗せが出る');
  assert.equal(ctx.sent.length, sentBefore + 1, 'チャンネルにも知らせる');

  await pressPoll(`pl:amount:${pollId}:0`, { type: 5, userId: OTHER, fields: { amount: '300' } });
  await pressPoll(`pl:amount:${pollId}:1`, { type: 5, userId: 'u9', fields: { amount: '100' } });

  const result = await pressPoll(`pl:settle:${pollId}`, { userId: ME, values: ['0'] });
  assert.match(result.data.embeds[0].description, /上乗せ/);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 700 + 1400, '賭け金400＋上乗せ1000を総取り');
  assert.equal(await eco.getBalance(db, GUILD, ME), 4000, '上乗せは戻らない');
});

await test('正解者がいなければ上乗せも出題者に戻る', async () => {
  await press('m:poll:create', {
    type: 5,
    fields: { question: '誰も当たらないお題', options: 'A\nB\nC', minutes: '60', stake: '' },
  });
  const pollId = (await db.get('SELECT * FROM polls ORDER BY id DESC')).id;

  await eco.setBalance(db, GUILD, ME, 2000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  await eco.setBalance(db, GUILD, 'u9', 1000, 'test');
  await pressPoll(`pl:bonus:${pollId}`, { type: 5, userId: ME, fields: { amount: '500' } });
  await pressPoll(`pl:amount:${pollId}:0`, { type: 5, userId: OTHER, fields: { amount: '300' } });
  await pressPoll(`pl:amount:${pollId}:1`, { type: 5, userId: 'u9', fields: { amount: '100' } });

  await pressPoll(`pl:settle:${pollId}`, { userId: ME, values: ['2'] });
  assert.equal(await eco.getBalance(db, GUILD, ME), 2000, '上乗せが戻る');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 1000, '賭け金が戻る');
  assert.equal(await eco.getBalance(db, GUILD, 'u9'), 1000);
});

await test('出題者は中止でき、賭け金も上乗せも全部戻る', async () => {
  await press('m:poll:create', {
    type: 5,
    fields: { question: '中止するお題', options: 'A\nB', minutes: '60', stake: '' },
  });
  const pollId = (await db.get('SELECT * FROM polls ORDER BY id DESC')).id;

  await eco.setBalance(db, GUILD, ME, 2000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  await pressPoll(`pl:bonus:${pollId}`, { type: 5, userId: ME, fields: { amount: '500' } });
  await pressPoll(`pl:amount:${pollId}:0`, { type: 5, userId: OTHER, fields: { amount: '300' } });

  const denied = await pressPoll(`pl:cancel:${pollId}`, { userId: OTHER });
  assert.match(screenText(denied), /出題者だけ/);

  const confirm = await pressPoll(`pl:cancel:${pollId}`, { userId: ME });
  assert.match(screenText(confirm), /中止しますか/);
  assert.equal((await pollLib.getPollById(db, pollId)).status, 'open', '確認だけでは中止しない');

  const editedBefore = ctx.edited.length;
  const done = await pressPoll(`pl:cancelok:${pollId}`, { userId: ME });
  assert.match(screenText(done), /中止しました/);
  assert.equal((await pollLib.getPollById(db, pollId)).status, 'cancelled');
  assert.equal(await eco.getBalance(db, GUILD, ME), 2000, '上乗せが戻る');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 1000, '賭け金が戻る');
  assert.equal(ctx.edited.length, editedBefore + 1, '掲示板も書き換える');
  assert.match(JSON.stringify(ctx.edited.at(-1).payload), /中止/);

  const again = await pressPoll(`pl:cancelok:${pollId}`, { userId: ME });
  assert.match(screenText(again), /もう終わって/);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 1000, '二重に返金しない');
});

section('[ショップ]');

await test('一覧から詳細を開ける', async () => {
  const payload = await press('m:shop:view', { values: [String(item.id)] });
  assert.match(firstEmbed(payload).title, /テスト商品/);
  assertAllButtonsWork(payload, '商品詳細');
});

await test('自分の出品は購入ボタンが押せない', async () => {
  const payload = await press('m:shop:view', { values: [String(myItem.id)] });
  const buy = payload.data.components[0].components.find((c) => c.custom_id === `m:shop:confirm:${myItem.id}`);
  assert.equal(buy.disabled, true);
});

await test('確認してから購入され、代金が出品者に渡る', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  const sellerBefore = await eco.getBalance(db, GUILD, OTHER);
  const confirmScreen = await press(`m:shop:confirm:${item.id}`);
  assert.ok(customIds(confirmScreen).includes(`m:shop:buy:${item.id}`));
  const sentBefore = ctx.sent.length;
  await press(`m:shop:buy:${item.id}`);
  assert.equal(await eco.getBalance(db, GUILD, ME), 700);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), sellerBefore + 300);
  assert.equal((await shop.getItem(db, GUILD, item.id)).stock, 4);
  assert.equal(ctx.sent.length, sentBefore + 1, '購入をチャンネルに告知');
});

await test('入力フォームから出品でき、チャンネルにも知らせる', async () => {
  const sentBefore = ctx.sent.length;
  const payload = await press('m:shop:create', {
    type: 5,
    fields: { name: '手作りクッキー', price: '250', description: '10枚入り', stock: '3', image_url: '' },
  });
  const items = await shop.listItems(db, GUILD, { sellerId: ME });
  const created = items.find((row) => row.name === '手作りクッキー');
  assert.equal(created.price, 250);
  assert.equal(created.stock, 3);
  assert.match(firstEmbed(payload).title, /手作りクッキー/);

  assert.equal(ctx.sent.length, sentBefore + 1, '出品のお知らせが1件');
  const announced = ctx.sent.at(-1).payload.embeds[0];
  assert.match(announced.title, /手作りクッキー/);
  assert.match(announced.title, /出品されました/);
  const fields = Object.fromEntries(announced.fields.map((field) => [field.name, field.value]));
  assert.match(fields['価格'], /250/);
  assert.equal(fields['在庫'], '3 個');
  assert.equal(fields['商品番号'], `#${created.id}`);
  assert.equal(fields['説明'], '10枚入り');
});

await test('画像URLを付けるとお知らせにも載る', async () => {
  await press('m:shop:create', {
    type: 5,
    fields: {
      name: '写真つき商品',
      price: '10',
      description: '',
      stock: '',
      image_url: 'https://example.invalid/a.png',
    },
  });
  const announced = ctx.sent.at(-1).payload.embeds[0];
  assert.equal(announced.image.url, 'https://example.invalid/a.png');
  assert.equal(Object.fromEntries(announced.fields.map((f) => [f.name, f.value]))['在庫'], '無制限');
});

await test('出品に失敗したときはお知らせを出さない', async () => {
  const sentBefore = ctx.sent.length;
  await press('m:shop:create', {
    type: 5,
    fields: { name: 'だめな出品', price: 'たかい', description: '', stock: '', image_url: '' },
  });
  assert.equal(ctx.sent.length, sentBefore, 'お知らせは出ない');
});

await test('価格に数字以外を入れると出品されない', async () => {
  const before = await shop.countItems(db, GUILD);
  const payload = await press('m:shop:create', {
    type: 5,
    fields: { name: 'だめな商品', price: 'たかい', description: '', stock: '', image_url: '' },
  });
  assert.equal(await shop.countItems(db, GUILD), before);
  assert.match(firstEmbed(payload).description, /数字/);
});

await test('画像URLの形が変なら出品されない', async () => {
  const before = await shop.countItems(db, GUILD);
  const payload = await press('m:shop:create', {
    type: 5,
    fields: { name: '画像テスト', price: '10', description: '', stock: '', image_url: 'ここに画像' },
  });
  assert.equal(await shop.countItems(db, GUILD), before);
  assert.match(firstEmbed(payload).description, /URL/);
});

await test('出品の取り下げと再開ができる', async () => {
  await press(`m:shop:remove:${myItem.id}`);
  assert.equal((await shop.getItem(db, GUILD, myItem.id)).active, 0);
  await press(`m:shop:remove:${myItem.id}`);
  assert.equal((await shop.getItem(db, GUILD, myItem.id)).active, 1);
});

await test('他人の出品は編集できない', async () => {
  const payload = await press(`m:shop:manage:${item.id}`);
  assert.match(firstEmbed(payload).description, /自分の出品/);
});

await test('編集フォームで内容を更新できる', async () => {
  await press(`m:shop:update:${myItem.id}`, {
    type: 5,
    fields: { name: '改名した商品', price: '150', description: '新しい説明', stock: '2', image_url: '' },
  });
  const updated = await shop.getItem(db, GUILD, myItem.id);
  assert.equal(updated.name, '改名した商品');
  assert.equal(updated.price, 150);
  assert.equal(updated.stock, 2);
});

section('[アイテムの種類と使用]');

await test('出品はまず種類を選ぶ', async () => {
  const payload = await press('m:shop:sell');
  const ids = customIds(payload);
  assert.ok(ids.includes('m:shop:sellform:consumable'));
  assert.ok(ids.includes('m:shop:sellform:permanent'));
  assertAllButtonsWork(payload, '出品の種類');
});

await test('種類ごとに入力フォームが開く', async () => {
  const payload = await press('m:shop:sellform:permanent');
  assert.equal(payload.type, 9, '入力フォームを開く');
  assert.equal(payload.data.custom_id, 'm:shop:create:permanent');
});

await test('使い切りは買うと持ち物から使えて、みんなに知らされる', async () => {
  await press('m:shop:create:consumable', {
    type: 5,
    fields: { name: '肩たたき券', price: '10', description: '10分間の肩たたき', stock: '', image_url: '' },
  });
  const listed = (await shop.listItems(db, GUILD, { sellerId: ME })).find((row) => row.name === '肩たたき券');
  assert.equal(listed.kind, 'consumable');

  // 別の人が2つ買う
  await eco.setBalance(db, GUILD, OTHER, 100, 'test');
  await shop.purchase(db, GUILD, listed.id, OTHER);
  await shop.purchase(db, GUILD, listed.id, OTHER);

  const detail = await press('m:shop:owned', { userId: OTHER, values: [String(listed.id)] });
  assert.match(firstEmbed(detail).title, /肩たたき券/);
  const fields = Object.fromEntries(firstEmbed(detail).fields.map((f) => [f.name, f.value]));
  assert.equal(fields['持っている数'], '2 個');
  assert.equal(fields['使える数'], '2 個');
  assert.ok(customIds(detail).includes(`m:shop:use:${listed.id}`));

  const sentBefore = ctx.sent.length;
  const afterUse = await press(`m:shop:use:${listed.id}`, { userId: OTHER });
  assert.equal(ctx.sent.length, sentBefore + 1, '使用のお知らせが1件');
  const announced = ctx.sent.at(-1).payload.embeds[0];
  assert.match(announced.title, /肩たたき券/);
  assert.match(announced.title, /使いました/);
  assert.equal(
    Object.fromEntries(announced.fields.map((f) => [f.name, f.value]))['説明'],
    '10分間の肩たたき',
    'お知らせに詳細が載る',
  );

  const left = Object.fromEntries(firstEmbed(afterUse).fields.map((f) => [f.name, f.value]));
  assert.equal(left['使える数'], '1 個', '使うと減る');
  assert.equal(left['持っている数'], '2 個', '持っていた記録は残る');
  globalThis.__consumableId = listed.id;
});

await test('使い切ると使うボタンが押せなくなる', async () => {
  const itemId = globalThis.__consumableId;
  await press(`m:shop:use:${itemId}`, { userId: OTHER });
  const payload = await press('m:shop:owned', { userId: OTHER, values: [String(itemId)] });
  const useButton = payload.data.components[0].components.find((c) => c.custom_id === `m:shop:use:${itemId}`);
  assert.equal(useButton.disabled, true);

  const sentBefore = ctx.sent.length;
  const again = await press(`m:shop:use:${itemId}`, { userId: OTHER });
  assert.equal(ctx.sent.length, sentBefore, '無いものは使えないので知らせない');
  assert.match(firstEmbed(again).description, /使えるものがありません/);
});

await test('ずっと残るアイテムには使うボタンが無い', async () => {
  await press('m:shop:create:permanent', {
    type: 5,
    fields: { name: '記念トロフィー', price: '10', description: '', stock: '', image_url: '' },
  });
  const listed = (await shop.listItems(db, GUILD, { sellerId: ME })).find((row) => row.name === '記念トロフィー');
  assert.equal(listed.kind, 'permanent');

  await eco.setBalance(db, GUILD, OTHER, 100, 'test');
  await shop.purchase(db, GUILD, listed.id, OTHER);

  const payload = await press('m:shop:owned', { userId: OTHER, values: [String(listed.id)] });
  assert.ok(!customIds(payload).includes(`m:shop:use:${listed.id}`), '使うボタンは出さない');
  assert.equal(await shop.useItem(db, GUILD, OTHER, listed.id), null, '直接呼んでも使えない');
});

await test('出品者は種類を切り替えられる', async () => {
  const listed = (await shop.listItems(db, GUILD, { sellerId: ME })).find((row) => row.name === '記念トロフィー');
  await press(`m:shop:kind:${listed.id}`);
  assert.equal((await shop.getItem(db, GUILD, listed.id)).kind, 'consumable');
  await press(`m:shop:kind:${listed.id}`);
  assert.equal((await shop.getItem(db, GUILD, listed.id)).kind, 'permanent');
});

await test('他人の出品の種類は変えられない', async () => {
  const payload = await press(`m:shop:kind:${item.id}`);
  assert.match(firstEmbed(payload).description, /自分の出品/);
});

await test('購入のお知らせは一行の簡素な文になる', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  const sentBefore = ctx.sent.length;
  await press(`m:shop:buy:${item.id}`);
  const message = ctx.sent.at(-1).payload;
  assert.equal(ctx.sent.length, sentBefore + 1);
  assert.equal(message.embeds, undefined, '埋め込みではなくただの文');
  assert.match(message.content, /購入しました/);
  assert.match(message.content, /テスト商品/);
});

section('[お財布]');

await test('送金するとチャンネルに告知が出る', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  const before = await eco.getBalance(db, GUILD, OTHER);
  const sentBefore = ctx.sent.length;
  await press(`m:wallet:paydo:${OTHER}`, { type: 5, fields: { amount: '300', memo: 'ありがとう' } });
  assert.equal(await eco.getBalance(db, GUILD, ME), 700);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), before + 300);
  assert.match(ctx.sent[sentBefore].payload.content, /ありがとう/);
});

await test('残高を超える送金は失敗する', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press(`m:wallet:paydo:${OTHER}`, { type: 5, fields: { amount: '999999', memo: '' } });
  assert.equal(await eco.getBalance(db, GUILD, ME), before);
  assert.match(firstEmbed(payload).description, /残高/);
});

await test('履歴が日本語のラベルで出る', async () => {
  const payload = await press('m:wallet:history');
  assert.match(firstEmbed(payload).description, /送金|報告|スロット/);
});

section('[管理メニュー]');

await test('権限が無ければ管理画面を開けない', async () => {
  const payload = await press('m:admin:open', { admin: false });
  assert.match(firstEmbed(payload).description, /権限/);
});

await test('権限が無ければ残高調整もできない', async () => {
  const before = await eco.getBalance(db, GUILD, OTHER);
  const payload = await press(`m:admin:balapply:give:${OTHER}`, {
    type: 5,
    admin: false,
    fields: { amount: '10000', reason: '' },
  });
  assert.equal(await eco.getBalance(db, GUILD, OTHER), before);
  assert.match(firstEmbed(payload).description, /権限/);
});

await test('権限が無ければアクションを消せない', async () => {
  const payload = await press('m:admin:actdel:筋トレ', { admin: false });
  assert.ok(await act.getActivity(db, GUILD, '筋トレ'), '消されていない');
  assert.match(firstEmbed(payload).description, /権限/);
});

await test('管理者はコインを配れる', async () => {
  const before = await eco.getBalance(db, GUILD, OTHER);
  const sentBefore = ctx.sent.length;
  await press(`m:admin:balapply:give:${OTHER}`, { type: 5, admin: true, fields: { amount: '500', reason: 'イベント' } });
  assert.equal(await eco.getBalance(db, GUILD, OTHER), before + 500);
  assert.match(ctx.sent[sentBefore].payload.content, /イベント/);
});

await test('管理者は残高を回収・設定できる', async () => {
  await press(`m:admin:balapply:set:${OTHER}`, { type: 5, admin: true, fields: { amount: '100', reason: '' } });
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 100);
  await press(`m:admin:balapply:take:${OTHER}`, { type: 5, admin: true, fields: { amount: '40', reason: '' } });
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 60);
});

await test('フォームからアクションを追加・改名できる', async () => {
  await press('m:admin:actsave', {
    type: 5,
    admin: true,
    fields: { name: '掃除', reward: '25', cooldown: '60', daily: '2', emoji: '🧹' },
  });
  const created = await act.getActivity(db, GUILD, '掃除');
  assert.equal(created.reward, 25);
  assert.equal(created.cooldown_sec, 3600);
  assert.equal(created.daily_limit, 2);

  await press('m:admin:actsave2:掃除', {
    type: 5,
    admin: true,
    fields: { name: '大掃除', reward: '99', cooldown: '', daily: '', emoji: '🧹' },
  });
  assert.equal(await act.getActivity(db, GUILD, '掃除'), null, '旧名は消える');
  assert.equal((await act.getActivity(db, GUILD, '大掃除')).reward, 99);
});

await test('アクションを削除できる', async () => {
  await press('m:admin:actdel:大掃除', { admin: true });
  assert.equal(await act.getActivity(db, GUILD, '大掃除'), null);
});

await test('通貨設定を変更できる', async () => {
  await press('m:admin:cfgsave', {
    type: 5,
    admin: true,
    fields: { currency_name: 'ポイント', currency_emoji: '⭐', starting_balance: '200', min_bet: '5', max_bet: '2000' },
  });
  const settings = await eco.getSettings(db, GUILD);
  assert.equal(settings.currency_name, 'ポイント');
  assert.equal(settings.starting_balance, 200);
  assert.equal(settings.max_bet, 2000);
});

await test('最高賭け金が最低より小さい設定は拒否される', async () => {
  const payload = await press('m:admin:cfgsave', {
    type: 5,
    admin: true,
    fields: { currency_name: 'ポイント', currency_emoji: '⭐', starting_balance: '200', min_bet: '100', max_bet: '10' },
  });
  assert.match(firstEmbed(payload).description, /最低賭け金/);
  assert.equal((await eco.getSettings(db, GUILD)).min_bet, 5, '拒否されたので変わらない');
});

section('[じゃんけんの公開メッセージ]');

const rpsChallenge = await import(src('menu/rps-challenge.js'));

async function pressRps(customId, options = {}) {
  const ix = new Ix(rawInteraction({ customId, ...options }));
  const response = await rpsChallenge.handleComponent(ix, ctx);
  await ctx.settle();
  return response.json();
}

await test('挑戦を受けると両者から賭け金が預かられる', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const settings = await ctx.settings(GUILD);
  await rpsChallenge.startChallenge(ctx, {
    guildId: GUILD, channelId: 'c1', challengerId: ME, opponentId: OTHER, bet: 100, settings,
  });
  const match = await db.get("SELECT * FROM rps_matches WHERE status = 'pending' ORDER BY created_at DESC");
  const payload = await pressRps(`rps:accept:${match.id}`, { userId: OTHER });
  assert.equal(payload.type, 7);
  assert.equal(await eco.getBalance(db, GUILD, ME), 900);
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 900);
  assert.equal((await db.get('SELECT * FROM rps_matches WHERE id = ?1', match.id)).status, 'playing');
  globalThis.__matchId = match.id;
});

await test('呼ばれていない人は勝負を受けられない', async () => {
  const payload = await pressRps(`rps:accept:${globalThis.__matchId}`, { userId: 'u3' });
  assert.match(screenText(payload), /終了|あなたではありません/);
});

await test('参加者以外は手を出せない', async () => {
  const payload = await pressRps(`rps:hand:${globalThis.__matchId}:rock`, { userId: 'u3' });
  assert.match(screenText(payload), /参加者ではありません/);
});

await test('手は相手に見えず、勝者が総取りする', async () => {
  const first = await pressRps(`rps:hand:${globalThis.__matchId}:rock`, { userId: ME });
  assert.equal(first.type, 4, '本人だけへの返事');
  assert.equal(first.data.flags, 64);

  const again = await pressRps(`rps:hand:${globalThis.__matchId}:paper`, { userId: ME });
  assert.match(screenText(again), /すでに手を出しています/);

  const result = await pressRps(`rps:hand:${globalThis.__matchId}:scissors`, { userId: OTHER });
  assert.equal(result.type, 7, '公開メッセージを結果に書き換える');
  assert.match(firstEmbed(result).description, /勝ち/);
  assert.equal(await eco.getBalance(db, GUILD, ME), 1100, 'グーがチョキに勝って総取り');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 900);
});

await test('終わった勝負のボタンはもう効かない', async () => {
  const payload = await pressRps(`rps:hand:${globalThis.__matchId}:rock`, { userId: ME });
  assert.match(screenText(payload), /終了/);
});

await test('二人が同時に手を出しても賞金は一度しか払われない', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const settings = await ctx.settings(GUILD);
  await rpsChallenge.startChallenge(ctx, {
    guildId: GUILD, channelId: 'c1', challengerId: ME, opponentId: OTHER, bet: 100, settings,
  });
  const pending = await db.get("SELECT * FROM rps_matches WHERE status = 'pending' ORDER BY created_at DESC");
  await pressRps(`rps:accept:${pending.id}`, { userId: OTHER });

  // 両者の手が揃った状態を作り、決着処理が同時に2回走る状況を再現する
  await db.run("UPDATE rps_matches SET challenger_hand = 'rock', opponent_hand = 'scissors' WHERE id = ?1", pending.id);
  const match = await db.get('SELECT * FROM rps_matches WHERE id = ?1', pending.id);

  const first = await rpsChallenge.resolveMatch(ctx, match);
  const second = await rpsChallenge.resolveMatch(ctx, match);

  assert.equal((await first.json()).type, 7, '先に取った方が結果を表示する');
  assert.equal((await second.json()).type, 4, 'あとの方は本人にだけ短く返す');

  assert.equal(await eco.getBalance(db, GUILD, ME), 1100, '勝者への支払いは1回だけ（900 + 200）');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 900);
});

await test('あいこも同時押しで二重に進まない', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const settings = await ctx.settings(GUILD);
  await rpsChallenge.startChallenge(ctx, {
    guildId: GUILD, channelId: 'c1', challengerId: ME, opponentId: OTHER, bet: 100, settings,
  });
  const pending = await db.get("SELECT * FROM rps_matches WHERE status = 'pending' ORDER BY created_at DESC");
  await pressRps(`rps:accept:${pending.id}`, { userId: OTHER });
  await db.run("UPDATE rps_matches SET challenger_hand = 'rock', opponent_hand = 'rock' WHERE id = ?1", pending.id);
  const match = await db.get('SELECT * FROM rps_matches WHERE id = ?1', pending.id);

  await rpsChallenge.resolveMatch(ctx, match);
  await rpsChallenge.resolveMatch(ctx, match);

  const after = await db.get('SELECT * FROM rps_matches WHERE id = ?1', pending.id);
  assert.equal(after.round, 2, 'ラウンドは1つだけ進む');
  assert.equal(after.challenger_hand, null);
});

await test('あいこが続いた末の返金も一度だけ', async () => {
  await eco.setBalance(db, GUILD, ME, 1000, 'test');
  await eco.setBalance(db, GUILD, OTHER, 1000, 'test');
  const settings = await ctx.settings(GUILD);
  await rpsChallenge.startChallenge(ctx, {
    guildId: GUILD, channelId: 'c1', challengerId: ME, opponentId: OTHER, bet: 100, settings,
  });
  const pending = await db.get("SELECT * FROM rps_matches WHERE status = 'pending' ORDER BY created_at DESC");
  await pressRps(`rps:accept:${pending.id}`, { userId: OTHER });
  await db.run(
    "UPDATE rps_matches SET challenger_hand = 'paper', opponent_hand = 'paper', round = 5 WHERE id = ?1",
    pending.id,
  );
  const match = await db.get('SELECT * FROM rps_matches WHERE id = ?1', pending.id);

  await rpsChallenge.resolveMatch(ctx, match);
  await rpsChallenge.resolveMatch(ctx, match);

  assert.equal(await eco.getBalance(db, GUILD, ME), 1000, '返金は1回だけ');
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 1000);
});


section('[自分のデータ]');

await test('保存されている内容を本人が確認できる', async () => {
  const payload = await press('m:privacy:open');
  const fields = firstEmbed(payload).fields.map((field) => field.name);
  assert.deepEqual(fields, ['所持金', 'コインの増減記録', '報告の記録', '出品', '購入履歴']);
  assertAllButtonsWork(payload, '自分のデータ');
});

await test('確認画面を挟んでから消える', async () => {
  const confirmScreen = await press('m:privacy:confirm');
  assert.ok(customIds(confirmScreen).includes('m:privacy:purge'));
  assert.match(firstEmbed(confirmScreen).description, /元には戻せません/);
});

await test('削除すると自分の記録が消え、他人の記録は残る', async () => {
  // 消す人の出品を他の人が買った状態を作る
  const sellItem = await shop.createItem(db, { guildId: GUILD, sellerId: ME, name: '消える人の商品', price: 10, stock: -1 });
  await eco.setBalance(db, GUILD, OTHER, 100, 'test');
  await shop.purchase(db, GUILD, sellItem.id, OTHER);

  await press('m:privacy:purge');

  assert.equal(await db.get('SELECT * FROM balances WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME), null);
  assert.equal((await db.all('SELECT * FROM ledger WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME)).length, 0);
  assert.equal((await db.all('SELECT * FROM activity_logs WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME)).length, 0);
  assert.equal((await db.all('SELECT * FROM shop_items WHERE guild_id = ?1 AND seller_id = ?2', GUILD, ME)).length, 0);
  assert.equal((await db.all('SELECT * FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2', GUILD, ME)).length, 0);

  const otherPurchase = await db.get('SELECT * FROM purchases WHERE guild_id = ?1 AND buyer_id = ?2 AND name = ?3', GUILD, OTHER, '消える人の商品');
  assert.ok(otherPurchase, '買った人の記録は残る');
  assert.equal(otherPurchase.seller_id, 'deleted', '出品者のIDは伏せられる');
});

await test('進行中のじゃんけんがあれば相手に返金してから消す', async () => {
  await eco.setBalance(db, GUILD, ME, 500, 'test');
  await eco.setBalance(db, GUILD, OTHER, 500, 'test');
  const settings = await ctx.settings(GUILD);
  await rpsChallenge.startChallenge(ctx, {
    guildId: GUILD, channelId: 'c1', challengerId: ME, opponentId: OTHER, bet: 200, settings,
  });
  const match = await db.get("SELECT * FROM rps_matches WHERE status = 'pending' ORDER BY created_at DESC");
  await pressRps(`rps:accept:${match.id}`, { userId: OTHER });
  assert.equal(await eco.getBalance(db, GUILD, OTHER), 300, '賭け金を預けた状態');

  await press('m:privacy:purge');

  assert.equal(await eco.getBalance(db, GUILD, OTHER), 500, '相手には返金される');
  assert.equal(await db.get('SELECT * FROM rps_matches WHERE id = ?1', match.id), null);
});

await test('削除後にまた遊ぶと初期残高から始まる', async () => {
  const settings = await eco.getSettings(db, GUILD);
  assert.equal(await eco.getBalance(db, GUILD, ME), settings.starting_balance);
});

section('[ホーム画面の整理]');

await test('ホームは6つのボタンだけ（ランキング・持ち物・使い方は置かない）', async () => {
  const payload = await press('m:home:open', { admin: true });
  const ids = customIds(payload);
  assert.deepEqual(ids, [
    'm:report:open',
    'm:games:open',
    'm:shop:open',
    'm:wallet:open',
    'm:home:open',
    'm:admin:open',
  ]);
});

await test('ランキングはお財布、持ち物はショップから開ける', async () => {
  assert.ok(customIds(await press('m:wallet:open')).includes('m:wallet:rank'), 'お財布にランキング');
  assert.ok(customIds(await press('m:shop:open')).includes('m:shop:inventory'), 'ショップに持ち物');
});

await test('ホームに連続記録が出る', async () => {
  const payload = await press('m:home:open');
  assert.ok(firstEmbed(payload).fields.some((field) => field.name === '連続記録'));
});

section('[連日ボーナス（管理者が作る）]');

await test('管理メニューから連日ボーナスと称号に行ける', async () => {
  const ids = customIds(await press('m:admin:open', { admin: true }));
  assert.ok(ids.includes('m:admin:streak'));
  assert.ok(ids.includes('m:admin:ach'));
});

await test('アクションを選んでからボーナスを設定する', async () => {
  const list = await press('m:admin:streak', { admin: true });
  const options = list.data.components[0].components[0].options.map((option) => option.value);
  assert.ok(options.includes('筋トレ'), 'アクションの一覧から選ぶ');

  const picked = await press('m:admin:streakact', { admin: true, values: ['筋トレ'] });
  assert.match(firstEmbed(picked).title, /筋トレ/);
  assertAllButtonsWork(picked, '連日ボーナス');
});

await test('範囲で追加でき、そのアクションにだけ付く', async () => {
  await press('m:admin:streaksave:筋トレ', {
    type: 5, admin: true, fields: { from_days: '3', to_days: '6', reward: '50' },
  });
  const payload = await press('m:admin:streakview:筋トレ', { admin: true });
  assert.match(firstEmbed(payload).description, /3〜6日目/);
  assert.match(firstEmbed(payload).description, /毎日/);

  const own = await streakLib.listStreakRewards(db, GUILD, '筋トレ');
  assert.equal(own.length, 1);
  assert.equal(own[0].from_days, 3);
  assert.equal(own[0].to_days, 6);
  assert.equal((await streakLib.listStreakRewards(db, GUILD, '勉強')).length, 0, '別のアクションには付かない');
});

await test('上限を空欄にすると、それ以降ずっとになる', async () => {
  await press('m:admin:streaksave:筋トレ', {
    type: 5, admin: true, fields: { from_days: '14', to_days: '', reward: '200' },
  });
  const payload = await press('m:admin:streakview:筋トレ', { admin: true });
  assert.match(firstEmbed(payload).description, /14日目以降/);
  assert.equal((await streakLib.findStreakReward(db, GUILD, '筋トレ', 999)).reward, 200);
});

await test('終わりが始まりより前だと弾かれる', async () => {
  const payload = await press('m:admin:streaksave:筋トレ', {
    type: 5, admin: true, fields: { from_days: '10', to_days: '2', reward: '50' },
  });
  assert.match(firstEmbed(payload).description, /以上にしてください/);
  assert.equal((await streakLib.listStreakRewards(db, GUILD, '筋トレ')).some((r) => r.from_days === 10), false);
});

await test('数字でない入力は弾かれる', async () => {
  const payload = await press('m:admin:streaksave:筋トレ', {
    type: 5, admin: true, fields: { from_days: 'さん', to_days: '', reward: '300' },
  });
  assert.match(firstEmbed(payload).description, /数字/);
});

await test('権限が無ければボーナスを作れない', async () => {
  const payload = await press('m:admin:streaksave:筋トレ', {
    type: 5, admin: false, fields: { from_days: '99', to_days: '', reward: '99999' },
  });
  assert.match(firstEmbed(payload).description, /権限/);
  assert.equal((await streakLib.listStreakRewards(db, GUILD, '筋トレ')).some((r) => r.from_days === 99), false);
});

await test('選ぶと削除できる', async () => {
  await press('m:admin:streakdel:筋トレ', { admin: true, values: ['3'] });
  assert.equal((await streakLib.listStreakRewards(db, GUILD, '筋トレ')).some((r) => r.from_days === 3), false);
  await press('m:admin:streakdel:筋トレ', { admin: true, values: ['14'] });
  assert.equal((await streakLib.listStreakRewards(db, GUILD, '筋トレ')).length, 0);
});

section('[称号（管理者が作る）]');

await test('条件の種類を選ぶ画面が出る', async () => {
  const payload = await press('m:admin:achnew', { admin: true });
  const options = payload.data.components[0].components[0].options.map((option) => option.value);
  assert.deepEqual(options.sort(), ['activity_count', 'activity_streak', 'balance', 'total_reports']);
});

await test('フォームから称号を作れる', async () => {
  await press('m:admin:achsave:total_reports', {
    type: 5,
    admin: true,
    fields: { name: '継続の鬼', emoji: '🔥', threshold: '100', reward: '500' },
  });
  const list = await achLib.listAchievements(db, GUILD);
  const created = list.find((achievement) => achievement.name === '継続の鬼');
  assert.equal(created.condition_type, 'total_reports');
  assert.equal(created.threshold, 100);
  assert.equal(created.reward, 500);
});

await test('存在しないアクションを条件にはできない', async () => {
  const payload = await press('m:admin:achsave:activity_count', {
    type: 5,
    admin: true,
    fields: { name: 'ヨガ王', emoji: '', threshold: '10', reward: '0', activity: 'ヨガ' },
  });
  assert.match(firstEmbed(payload).description, /登録されていません/);
  assert.equal((await achLib.listAchievements(db, GUILD)).some((a) => a.name === 'ヨガ王'), false);
});

await test('権限が無ければ称号を作れない', async () => {
  const payload = await press('m:admin:achsave:total_reports', {
    type: 5,
    admin: false,
    fields: { name: '勝手に作った称号', emoji: '', threshold: '1', reward: '99999' },
  });
  assert.match(firstEmbed(payload).description, /権限/);
  assert.equal((await achLib.listAchievements(db, GUILD)).some((a) => a.name === '勝手に作った称号'), false);
});

await test('メンバーは称号画面で獲得状況を見られる', async () => {
  const payload = await press('m:titles:open');
  const names = firstEmbed(payload).fields.map((field) => field.name);
  assert.ok(names.some((name) => name.includes('連続記録')));
  assert.ok(names.some((name) => name.includes('称号')));
  assertAllButtonsWork(payload, '称号画面');
});

await test('報告すると連続日数と称号がまとめて処理される', async () => {
  await achLib.createAchievement(db, GUILD, {
    name: 'はじめの一歩',
    condition_type: 'activity_count',
    threshold: 1,
    activity_name: 'ランニング',
    reward: 50,
  });
  await streakLib.upsertStreakReward(db, GUILD, 'ランニング', 1, 0, 100);
  const fresh = 'userFresh';
  const ix = new Ix(rawInteraction({ customId: 'm:report:pick', values: ['ランニング'], userId: fresh }));
  const response = await handleComponent(ix, ctx);
  await ctx.settle();
  const payload = await response.json();

  assert.match(firstEmbed(payload).title, /ランニング/);
  const announced = ctx.sent.at(-1).payload.embeds[0];
  assert.match(announced.description, /連続ボーナス/);
  assert.match(announced.description, /はじめの一歩/);
  assert.ok(announced.fields.some((field) => field.name.includes('連続')));
});

await test('獲得した称号を選ぶと名前の横に出る', async () => {
  const fresh = 'userTitle';
  await achLib.createAchievement(db, GUILD, {
    name: '一歩目',
    emoji: '🥇',
    condition_type: 'activity_count',
    threshold: 1,
    activity_name: '早起き',
    reward: 0,
  });
  await act.logReport(db, GUILD, fresh, '早起き', 10);
  await achLib.evaluate(db, { guildId: GUILD, userId: fresh, timezone: 'Asia/Tokyo' });

  const list = await achLib.earnedBy(db, GUILD, fresh);
  const target = list.find((achievement) => achievement.name === '一歩目');

  const ix = new Ix(rawInteraction({ customId: 'm:titles:equip', values: [String(target.id)], userId: fresh }));
  const payload = await (await handleComponent(ix, ctx)).json();
  assert.match(firstEmbed(payload).author.name, /一歩目/, '名前の横に称号が出る');
  assert.match(firstEmbed(payload).description, /一歩目/);

  const equipped = await achLib.equippedTitle(db, GUILD, fresh);
  assert.equal(equipped.name, '一歩目');
});

await test('称号を外せる', async () => {
  const fresh = 'userTitle';
  const ix = new Ix(rawInteraction({ customId: 'm:titles:equip', values: ['none'], userId: fresh }));
  await handleComponent(ix, ctx);
  assert.equal(await achLib.equippedTitle(db, GUILD, fresh), null);
});

section('[定期発表（管理者が作る）]');

await test('管理メニューから定期発表に行ける', async () => {
  const ids = customIds(await press('m:admin:open', { admin: true }));
  assert.ok(ids.includes('m:admin:ann'));
  const payload = await press('m:admin:ann', { admin: true });
  assertAllButtonsWork(payload, '定期発表');
});

await test('チャンネル→種類→頻度→詳細の順に設定できる', async () => {
  const step1 = await press('m:admin:annnew', { admin: true });
  assert.equal(step1.data.components[0].components[0].type, 8, 'チャンネル選択メニュー');

  const step2 = await press('m:admin:annch', { admin: true, values: ['chan99'] });
  const metrics = step2.data.components[0].components[0].options.map((option) => option.value);
  assert.deepEqual(metrics.sort(), ['activity_count', 'activity_streak', 'activity_total', 'balance', 'earned']);

  const step3 = await press('m:admin:annmetric:chan99', { admin: true, values: ['activity_streak'] });
  const whens = step3.data.components[0].components[0].options.map((option) => option.value);
  assert.equal(whens[0], 'daily');
  assert.equal(whens.length, 8, '毎日＋曜日7つ');

  await press('m:admin:annsave:chan99:activity_streak:daily', {
    type: 5,
    admin: true,
    fields: { hour: '9', top_n: '3', prize: '500', activity: '筋トレ' },
  });

  const list = await annLib.listAnnouncements(db, GUILD);
  const created = list.find((row) => row.channel_id === 'chan99');
  assert.equal(created.metric, 'activity_streak');
  assert.equal(created.activity_name, '筋トレ');
  assert.equal(created.hour, 9);
  assert.equal(created.top_n, 3);
  assert.equal(created.prize, 500);
  assert.equal(created.frequency, 'daily');
});

await test('時刻や対象アクションがおかしいと作られない', async () => {
  const before = (await annLib.listAnnouncements(db, GUILD)).length;
  const badHour = await press('m:admin:annsave:chan99:balance:daily', {
    type: 5, admin: true, fields: { hour: '99', top_n: '3', prize: '0' },
  });
  assert.match(firstEmbed(badHour).description, /0 〜 23/);

  const badActivity = await press('m:admin:annsave:chan99:activity_streak:daily', {
    type: 5, admin: true, fields: { hour: '9', top_n: '3', prize: '0', activity: 'ヨガ' },
  });
  assert.match(firstEmbed(badActivity).description, /登録されていません/);
  assert.equal((await annLib.listAnnouncements(db, GUILD)).length, before);
});

await test('権限が無ければ作れない', async () => {
  const before = (await annLib.listAnnouncements(db, GUILD)).length;
  const payload = await press('m:admin:annsave:chan99:balance:daily', {
    type: 5, admin: false, fields: { hour: '9', top_n: '3', prize: '0' },
  });
  assert.match(firstEmbed(payload).description, /権限/);
  assert.equal((await annLib.listAnnouncements(db, GUILD)).length, before);
});

await test('停止・再開・削除ができる', async () => {
  const list = await annLib.listAnnouncements(db, GUILD);
  const target = list.find((row) => row.channel_id === 'chan99');

  const view = await press(`m:admin:annpick`, { admin: true, values: [String(target.id)] });
  assertAllButtonsWork(view, '発表の設定');

  await press(`m:admin:anntoggle:${target.id}`, { admin: true });
  assert.equal((await annLib.getAnnouncement(db, GUILD, target.id)).enabled, 0);
  await press(`m:admin:anntoggle:${target.id}`, { admin: true });
  assert.equal((await annLib.getAnnouncement(db, GUILD, target.id)).enabled, 1);

  await press(`m:admin:anndel:${target.id}`, { admin: true });
  assert.equal(await annLib.getAnnouncement(db, GUILD, target.id), null);
});

runner.done();
db.close();
