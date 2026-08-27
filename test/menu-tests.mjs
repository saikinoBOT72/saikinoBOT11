// メニュー（ボタン・セレクト・入力フォーム）の画面遷移を、Discord に接続せずに検証する。
//   1. 画面に置いたボタンがすべて実在するハンドラに届くか（押しても無反応なボタンが無いか）
//   2. 実際の操作でコイン・アイテムが正しく動くか
//   3. 権限のない人が管理操作をできないか
import assert from 'node:assert/strict';
import { createRunner, createTestContext, customIds, firstEmbed, rawInteraction, screenText, src } from './harness.mjs';

const { screens, handleComponent, findHandler } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));
const { findCommand, COMMAND_DEFINITIONS } = await import(src('commands.js'));
const eco = await import(src('lib/economy.js'));
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

await test('スロットは賭け金が引かれ、結果が出る', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:slot:bet:100');
  const after = await eco.getBalance(db, GUILD, ME);
  assert.ok(after <= before + 300000 && after >= before - 100);
  assert.match(firstEmbed(payload).description, /🍒|🍋|🍇|🔔|⭐|7️⃣|💎/);
  assertAllButtonsWork(payload, 'スロット結果');
});

await test('所持金を超える賭け金は弾かれる', async () => {
  await eco.setBalance(db, GUILD, ME, 50, 'test');
  const payload = await press('m:slot:bet:1000');
  assert.equal(await eco.getBalance(db, GUILD, ME), 50);
  assert.match(firstEmbed(payload).description, /残高|上限/);
  await eco.setBalance(db, GUILD, ME, 5000, 'test');
});

await test('入力フォームの金額（全角も可）でスロットが回る', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  await press('m:slot:amount', { type: 5, fields: { amount: '２００' } });
  assert.notEqual(await eco.getBalance(db, GUILD, ME), before);
});

await test('数字でない入力は弾かれる', async () => {
  const before = await eco.getBalance(db, GUILD, ME);
  const payload = await press('m:slot:amount', { type: 5, fields: { amount: 'いっぱい' } });
  assert.equal(await eco.getBalance(db, GUILD, ME), before);
  assert.match(firstEmbed(payload).description, /数字/);
});

await test('コイントスは表裏を選んでから勝負する', async () => {
  const payload = await press('m:cf:bet:100');
  const ids = customIds(payload);
  assert.ok(ids.includes('m:cf:go:100:heads') && ids.includes('m:cf:go:100:tails'));
  const before = await eco.getBalance(db, GUILD, ME);
  await press('m:cf:go:100:heads');
  const after = await eco.getBalance(db, GUILD, ME);
  assert.ok(after === before + 100 || after === before - 100, `${before} → ${after}`);
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

await test('入力フォームから出品できる', async () => {
  const payload = await press('m:shop:create', {
    type: 5,
    fields: { name: '手作りクッキー', price: '250', description: '10枚入り', stock: '3', image_url: '' },
  });
  const items = await shop.listItems(db, GUILD, { sellerId: ME });
  const created = items.find((row) => row.name === '手作りクッキー');
  assert.equal(created.price, 250);
  assert.equal(created.stock, 3);
  assert.match(firstEmbed(payload).title, /手作りクッキー/);
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

runner.done();
db.close();
