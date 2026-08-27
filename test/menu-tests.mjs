// メニュー（ボタン／セレクト／入力フォーム）の画面遷移を、Discord に接続せずに検証する。
// 偽のインタラクションを流し込み、
//   1. 画面に置いたボタンの customId がすべて実在するハンドラに届くか（押しても無反応なボタンが無いか）
//   2. 実際の操作でコインやアイテムが正しく動くか
// を確認する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-menu-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');
process.env.IMAGE_DIR = path.join(tmp, 'images');
process.env.CLIENT_ID = '123';
process.env.DISCORD_TOKEN = 'x';
process.env.TZ = 'Asia/Tokyo';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (name) => pathToFileURL(path.join(here, '..', 'src', name)).href;

const { screens, handleComponent } = await import(src('menu/router.js'));
const eco = await import(src('lib/economy.js'));
const act = await import(src('lib/activities.js'));
const shop = await import(src('lib/shop.js'));
const { getDb } = await import(src('lib/db.js'));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const GUILD = 'g1';
const ME = 'u1';
const OTHER = 'u2';

/** 押されたボタン・送られたメッセージを記録する偽インタラクション。 */
function fake({ customId = 'm:home:open', values = [], fields = null, admin = false, userId = ME } = {}) {
  const captured = { screens: [], toasts: [], modals: [], sent: [] };
  const self = {
    captured,
    customId,
    values,
    guildId: GUILD,
    user: { id: userId, username: 'tester', bot: false, displayAvatarURL: () => 'https://example.invalid/a.png' },
    member: { displayName: 'テスター' },
    memberPermissions: { has: () => admin },
    replied: false,
    deferred: false,
    fields: { getTextInputValue: (key) => (fields?.[key] ?? '') },
    client: {
      user: { id: 'bot', username: 'Bot' },
      users: { fetch: async (id) => ({ id, bot: id === 'bot', username: `user${id}` }) },
    },
    channel: {
      id: 'c1',
      isSendable: () => true,
      send: async (payload) => { captured.sent.push(payload); return { id: `msg${captured.sent.length}` }; },
      // 画像は届かない想定（時間切れの経路を通す）
      awaitMessages: async () => ({ first: () => undefined }),
      get client() { return self.client; },
    },
    isModalSubmit: () => fields !== null,
    isFromMessage: () => true,
    isChatInputCommand: () => false,
    update: async (payload) => { captured.screens.push(payload); self.replied = true; },
    editReply: async (payload) => { captured.screens.push(payload); },
    reply: async (payload) => {
      if (payload.content && !payload.embeds?.length) captured.toasts.push(payload.content);
      else captured.screens.push(payload);
      self.replied = true;
    },
    followUp: async (payload) => { captured.toasts.push(payload.content); },
    showModal: async (modal) => { captured.modals.push(modal.toJSON()); },
  };
  return self;
}

/** 画面に出ている customId をすべて集める。 */
function customIds(payload) {
  const ids = [];
  for (const rowBuilder of payload?.components ?? []) {
    const row = typeof rowBuilder.toJSON === 'function' ? rowBuilder.toJSON() : rowBuilder;
    for (const component of row.components ?? []) ids.push(component.custom_id);
  }
  return ids.filter(Boolean);
}

function resolves(customId) {
  const [prefix, screen, action] = customId.split(':');
  return prefix === 'm' && typeof screens[screen]?.[action] === 'function';
}

async function press(customId, options = {}) {
  const interaction = fake({ customId, ...options });
  await handleComponent(interaction);
  return interaction.captured;
}

// 下ごしらえ
eco.setBalance(GUILD, ME, 5000, 'test');
eco.setBalance(GUILD, OTHER, 500, 'test');
for (const preset of act.PRESET_ACTIVITIES) act.upsertActivity(GUILD, preset);
const item = shop.createItem({ guildId: GUILD, sellerId: OTHER, name: 'テスト商品', price: 300, stock: 5 });
const myItem = shop.createItem({ guildId: GUILD, sellerId: ME, name: '自分の商品', price: 100, stock: -1 });

console.log('\n[メニューの画面遷移]');

await test('ホームのボタンがすべて生きている', async () => {
  const { screens: rendered } = await press('m:home:open');
  const ids = customIds(rendered[0]);
  assert.ok(ids.length >= 7, `ボタン数: ${ids.length}`);
  for (const cid of ids) assert.ok(resolves(cid), `届かないボタン: ${cid}`);
});

await test('管理者だけに管理ボタンが出る', async () => {
  const normal = await press('m:home:open', { admin: false });
  const manager = await press('m:home:open', { admin: true });
  assert.ok(!customIds(normal.screens[0]).includes('m:admin:open'));
  assert.ok(customIds(manager.screens[0]).includes('m:admin:open'));
});

await test('主要画面のボタンがすべて生きている', async () => {
  const entries = [
    ['m:home:help'], ['m:report:open'], ['m:report:stats'], ['m:games:open'], ['m:slot:open'],
    ['m:cf:open'], ['m:rps:open'], ['m:shop:open'], ['m:shop:mine'], ['m:shop:inventory'],
    ['m:wallet:open'], ['m:wallet:pay'], ['m:wallet:history'], ['m:wallet:rank'],
    ['m:admin:open', { admin: true }], ['m:admin:acts', { admin: true }], ['m:admin:bal', { admin: true }],
  ];
  for (const [cid, options] of entries) {
    const { screens: rendered } = await press(cid, options ?? {});
    assert.ok(rendered.length > 0, `${cid} が何も表示しなかった`);
    for (const found of customIds(rendered.at(-1))) {
      assert.ok(resolves(found), `${cid} の中の届かないボタン: ${found}`);
    }
  }
});

await test('未知の customId でも落ちない', async () => {
  await press('m:nowhere:nothing');
});

console.log('\n[報告]');

await test('選ぶだけで報告が成立し、チャンネルにも投稿される', async () => {
  const before = eco.getBalance(GUILD, ME);
  const activity = act.getActivity(GUILD, '早起き');
  const { screens: rendered, sent } = await press('m:report:pick', { values: ['早起き'] });
  assert.equal(eco.getBalance(GUILD, ME), before + activity.reward);
  assert.equal(sent.length, 1, '公開投稿が1件');
  assert.match(rendered.at(-1).embeds[0].data.title, /早起き/);
});

await test('クールダウン中はお知らせが出て残高が動かない', async () => {
  const before = eco.getBalance(GUILD, ME);
  const { toasts } = await press('m:report:pick', { values: ['早起き'] });
  assert.equal(eco.getBalance(GUILD, ME), before);
  assert.ok(toasts.some((t) => t.includes('1日') || t.includes('クールダウン')), toasts.join('/'));
});

await test('写真必須のアクションは画像を待つ（時間切れなら報酬なし）', async () => {
  const before = eco.getBalance(GUILD, ME);
  const { screens: rendered } = await press('m:report:pick', { values: ['自炊'] });
  assert.match(rendered[0].embeds[0].data.description, /画像|写真/);
  assert.equal(eco.getBalance(GUILD, ME), before, '時間切れでは支払われない');
  assert.match(rendered.at(-1).embeds[0].data.title, /報告できませんでした/);
});

console.log('\n[ゲーム]');

await test('スロットは賭け金が引かれ、結果画面が出る', async () => {
  const before = eco.getBalance(GUILD, ME);
  const { screens: rendered } = await press('m:slot:bet:100');
  const after = eco.getBalance(GUILD, ME);
  assert.ok(after <= before + 3000 && after >= before - 100);
  const embed = rendered.at(-1).embeds[0].data;
  assert.match(embed.description, /🍒|🍋|🍇|🔔|⭐|7️⃣|💎/);
  for (const cid of customIds(rendered.at(-1))) assert.ok(resolves(cid), cid);
});

await test('所持金を超える賭け金は弾かれる', async () => {
  eco.setBalance(GUILD, ME, 50, 'test');
  const { toasts } = await press('m:slot:bet:1000');
  assert.equal(eco.getBalance(GUILD, ME), 50);
  assert.ok(toasts.some((t) => t.includes('残高') || t.includes('上限')), toasts.join('/'));
  eco.setBalance(GUILD, ME, 5000, 'test');
});

await test('入力フォームの金額でスロットが回る', async () => {
  const before = eco.getBalance(GUILD, ME);
  await press('m:slot:amount', { fields: { amount: '２００' } }); // 全角も受け付ける
  assert.notEqual(eco.getBalance(GUILD, ME), before);
});

await test('数字でない入力は弾かれる', async () => {
  const before = eco.getBalance(GUILD, ME);
  const { toasts } = await press('m:slot:amount', { fields: { amount: 'いっぱい' } });
  assert.equal(eco.getBalance(GUILD, ME), before);
  assert.ok(toasts[0].includes('数字'));
});

await test('コイントスは表裏の選択画面を経て勝負する', async () => {
  const { screens: rendered } = await press('m:cf:bet:100');
  const ids = customIds(rendered.at(-1));
  assert.ok(ids.includes('m:cf:go:100:heads') && ids.includes('m:cf:go:100:tails'));
  const before = eco.getBalance(GUILD, ME);
  await press('m:cf:go:100:heads');
  const after = eco.getBalance(GUILD, ME);
  assert.ok(after === before + 100 || after === before - 100, `${before} → ${after}`);
});

await test('じゃんけんは挑戦状がチャンネルに投稿される', async () => {
  const { sent, screens: rendered } = await press('m:rps:go:u2:100');
  assert.equal(sent.length, 1);
  assert.match(rendered.at(-1).embeds[0].data.title, /挑戦状/);
  const match = getDb().prepare("SELECT * FROM rps_matches WHERE guild_id = ? AND status = 'pending'").get(GUILD);
  assert.equal(match.opponent_id, OTHER);
  assert.equal(match.bet, 100);
});

await test('自分自身には挑戦できない', async () => {
  const { toasts } = await press('m:rps:user', { values: [ME] });
  assert.ok(toasts[0].includes('自分自身'));
});

console.log('\n[ショップ]');

await test('一覧から詳細を開ける', async () => {
  const { screens: rendered } = await press('m:shop:view', { values: [String(item.id)] });
  const embed = rendered.at(-1).embeds[0].data;
  assert.match(embed.title, /テスト商品/);
  for (const cid of customIds(rendered.at(-1))) assert.ok(resolves(cid), cid);
});

await test('自分の出品には購入ボタンが出ない（押せない）', async () => {
  const { screens: rendered } = await press('m:shop:view', { values: [String(myItem.id)] });
  const row = rendered.at(-1).components[0].toJSON();
  const buy = row.components.find((c) => c.custom_id === `m:shop:confirm:${myItem.id}`);
  assert.equal(buy.disabled, true);
});

await test('確認してから購入され、代金が出品者に渡る', async () => {
  eco.setBalance(GUILD, ME, 1000, 'test');
  const sellerBefore = eco.getBalance(GUILD, OTHER);
  const confirmScreen = await press(`m:shop:confirm:${item.id}`);
  assert.ok(customIds(confirmScreen.screens.at(-1)).includes(`m:shop:buy:${item.id}`));
  const { sent } = await press(`m:shop:buy:${item.id}`);
  assert.equal(eco.getBalance(GUILD, ME), 700);
  assert.equal(eco.getBalance(GUILD, OTHER), sellerBefore + 300);
  assert.equal(shop.getItem(GUILD, item.id).stock, 4);
  assert.equal(sent.length, 1, '購入をチャンネルに告知');
});

await test('入力フォームから出品できる', async () => {
  const { screens: rendered } = await press('m:shop:create', {
    fields: { name: '手作りクッキー', price: '250', description: '10枚入り', stock: '3', image_url: '' },
  });
  const created = shop.listItems(GUILD, { sellerId: ME }).find((i) => i.name === '手作りクッキー');
  assert.equal(created.price, 250);
  assert.equal(created.stock, 3);
  assert.match(rendered.at(-1).embeds[0].data.title, /手作りクッキー/);
});

await test('価格に数字以外を入れると出品されない', async () => {
  const before = shop.countItems(GUILD);
  const { toasts } = await press('m:shop:create', {
    fields: { name: 'だめな商品', price: 'たかい', description: '', stock: '', image_url: '' },
  });
  assert.equal(shop.countItems(GUILD), before);
  assert.ok(toasts[0].includes('数字'));
});

await test('出品の取り下げと再開ができる', async () => {
  await press(`m:shop:remove:${myItem.id}`);
  assert.equal(shop.getItem(GUILD, myItem.id).active, 0);
  await press(`m:shop:remove:${myItem.id}`);
  assert.equal(shop.getItem(GUILD, myItem.id).active, 1);
});

await test('他人の出品は編集できない', async () => {
  const { toasts } = await press(`m:shop:manage:${item.id}`);
  assert.ok(toasts[0].includes('自分の出品'));
});

await test('編集フォームで内容を更新できる', async () => {
  await press(`m:shop:update:${myItem.id}`, {
    fields: { name: '改名した商品', price: '150', description: '新しい説明', stock: '2' },
  });
  const updated = shop.getItem(GUILD, myItem.id);
  assert.equal(updated.name, '改名した商品');
  assert.equal(updated.price, 150);
  assert.equal(updated.stock, 2);
});

console.log('\n[お財布]');

await test('送金するとチャンネルに告知が出る', async () => {
  eco.setBalance(GUILD, ME, 1000, 'test');
  const before = eco.getBalance(GUILD, OTHER);
  const { sent } = await press(`m:wallet:paydo:${OTHER}`, { fields: { amount: '300', memo: 'ありがとう' } });
  assert.equal(eco.getBalance(GUILD, ME), 700);
  assert.equal(eco.getBalance(GUILD, OTHER), before + 300);
  assert.ok(sent[0].content.includes('ありがとう'));
});

await test('残高を超える送金は失敗する', async () => {
  const before = eco.getBalance(GUILD, ME);
  const { toasts } = await press(`m:wallet:paydo:${OTHER}`, { fields: { amount: '999999', memo: '' } });
  assert.equal(eco.getBalance(GUILD, ME), before);
  assert.ok(toasts.some((t) => t.includes('残高')));
});

await test('履歴に日本語のラベルが出る', async () => {
  const { screens: rendered } = await press('m:wallet:history');
  assert.match(rendered.at(-1).embeds[0].data.description, /送金|報告|スロット/);
});

console.log('\n[管理メニュー]');

await test('権限が無ければ管理操作を拒否する', async () => {
  const { toasts } = await press('m:admin:open', { admin: false });
  assert.ok(toasts[0].includes('権限'));
});

await test('権限が無ければ残高調整も拒否する', async () => {
  const before = eco.getBalance(GUILD, OTHER);
  const { toasts } = await press(`m:admin:balapply:give:${OTHER}`, { admin: false, fields: { amount: '10000', reason: '' } });
  assert.equal(eco.getBalance(GUILD, OTHER), before);
  assert.ok(toasts[0].includes('権限'));
});

await test('管理者はコインを配れる', async () => {
  const before = eco.getBalance(GUILD, OTHER);
  const { sent } = await press(`m:admin:balapply:give:${OTHER}`, { admin: true, fields: { amount: '500', reason: 'イベント' } });
  assert.equal(eco.getBalance(GUILD, OTHER), before + 500);
  assert.ok(sent[0].content.includes('イベント'));
});

await test('管理者は残高を回収・設定できる', async () => {
  await press(`m:admin:balapply:set:${OTHER}`, { admin: true, fields: { amount: '100', reason: '' } });
  assert.equal(eco.getBalance(GUILD, OTHER), 100);
  await press(`m:admin:balapply:take:${OTHER}`, { admin: true, fields: { amount: '40', reason: '' } });
  assert.equal(eco.getBalance(GUILD, OTHER), 60);
});

await test('フォームからアクションを追加・編集できる', async () => {
  await press('m:admin:actsave', { admin: true, fields: { name: '掃除', reward: '25', cooldown: '60', daily: '2', emoji: '🧹' } });
  const created = act.getActivity(GUILD, '掃除');
  assert.equal(created.reward, 25);
  assert.equal(created.cooldown_sec, 3600);
  assert.equal(created.daily_limit, 2);

  await press('m:admin:actsave2:掃除', { admin: true, fields: { name: '大掃除', reward: '99', cooldown: '', daily: '', emoji: '🧹' } });
  assert.equal(act.getActivity(GUILD, '掃除'), undefined, '旧名は消える');
  assert.equal(act.getActivity(GUILD, '大掃除').reward, 99);
});

await test('写真必須の切り替えができる', async () => {
  await press('m:admin:actproof:大掃除', { admin: true });
  assert.equal(act.getActivity(GUILD, '大掃除').need_proof, 1);
  await press('m:admin:actproof:大掃除', { admin: true });
  assert.equal(act.getActivity(GUILD, '大掃除').need_proof, 0);
});

await test('アクションを削除できる', async () => {
  await press('m:admin:actdel:大掃除', { admin: true });
  assert.equal(act.getActivity(GUILD, '大掃除'), undefined);
});

await test('通貨設定を変更できる', async () => {
  await press('m:admin:cfgsave', {
    admin: true,
    fields: { currency_name: 'ポイント', currency_emoji: '⭐', starting_balance: '200', min_bet: '5', max_bet: '2000' },
  });
  const settings = eco.getSettings(GUILD);
  assert.equal(settings.currency_name, 'ポイント');
  assert.equal(settings.starting_balance, 200);
  assert.equal(settings.max_bet, 2000);
});

await test('最高賭け金が最低より小さい設定は拒否される', async () => {
  const { toasts } = await press('m:admin:cfgsave', {
    admin: true,
    fields: { currency_name: 'ポイント', currency_emoji: '⭐', starting_balance: '200', min_bet: '100', max_bet: '10' },
  });
  assert.ok(toasts[0].includes('最低賭け金'));
  assert.equal(eco.getSettings(GUILD).min_bet, 5, '拒否されたので変わらない');
});

console.log(`\n${passed} 件のテストが通りました`);
fs.rmSync(tmp, { recursive: true, force: true });
