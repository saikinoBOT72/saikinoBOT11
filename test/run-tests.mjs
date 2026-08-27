// 通貨・報告・ショップ・じゃんけん・スロットのロジックを検証する。
// Cloudflare には接続せず、D1 は better-sqlite3 製の偽物を使う。実行: npm test
import assert from 'node:assert/strict';
import { createRunner, createTestContext, src } from './harness.mjs';

const eco = await import(src('lib/economy.js'));
const act = await import(src('lib/activities.js'));
const shop = await import(src('lib/shop.js'));
const rps = await import(src('lib/rps.js'));
const slot = await import(src('lib/slot.js'));
const fmt = await import(src('lib/format.js'));
const wager = await import(src('lib/wager.js'));
const verify = await import(src('discord/verify.js'));
const builders = await import(src('discord/builders.js'));

const runner = createRunner('[ロジック]');
const { test, section } = runner;
const ctx = createTestContext();
const db = ctx.db;

const G = 'guild1';
const A = 'userA';
const B = 'userB';

section('[通貨]');

await test('初期残高が入る', async () => {
  const settings = await eco.getSettings(db, G);
  assert.equal(settings.starting_balance, 100);
  assert.equal(await eco.getBalance(db, G, A), 100);
});

await test('入金・出金', async () => {
  await eco.deposit(db, G, A, 50, 'test');
  assert.equal(await eco.getBalance(db, G, A), 150);
  assert.equal(await eco.withdraw(db, G, A, 100, 'test'), true);
  assert.equal(await eco.getBalance(db, G, A), 50);
});

await test('残高不足の出金は失敗して残高が動かない', async () => {
  assert.equal(await eco.withdraw(db, G, A, 999, 'test'), false);
  assert.equal(await eco.getBalance(db, G, A), 50);
});

await test('送金', async () => {
  await eco.ensureAccount(db, G, B);
  assert.equal(await eco.transfer(db, G, A, B, 30, 'pay'), true);
  assert.equal(await eco.getBalance(db, G, A), 20);
  assert.equal(await eco.getBalance(db, G, B), 130);
});

await test('残高不足の送金は両者とも動かない', async () => {
  assert.equal(await eco.transfer(db, G, A, B, 500, 'pay'), false);
  assert.equal(await eco.getBalance(db, G, A), 20);
  assert.equal(await eco.getBalance(db, G, B), 130);
});

await test('管理者調整は0未満にならない', async () => {
  await eco.adjust(db, G, A, -9999, 'admin:take');
  assert.equal(await eco.getBalance(db, G, A), 0);
  await eco.setBalance(db, G, A, 1000, 'admin:set');
  assert.equal(await eco.getBalance(db, G, A), 1000);
});

await test('ランキングと順位', async () => {
  const top = await eco.topBalances(db, G, 10);
  assert.equal(top[0].user_id, A);
  assert.equal(await eco.rankOf(db, G, A), 1);
  assert.equal(await eco.rankOf(db, G, B), 2);
});

await test('台帳に全ての増減が残る', async () => {
  const rows = await eco.ledgerFor(db, G, A, 100);
  assert.ok(rows.length >= 6, `ledger rows: ${rows.length}`);
  const sums = await eco.totals(db, G, A);
  assert.ok(sums.earned > 0 && sums.spent > 0);
});

await test('別サーバーの残高は混ざらない', async () => {
  assert.equal(await eco.getBalance(db, 'guild2', A), 100);
  assert.equal(await eco.getBalance(db, G, A), 1000);
});

section('[賭け金の判定]');

await test('上限・下限・残高で弾く', () => {
  const settings = { min_bet: 10, max_bet: 500, currency_name: 'コイン', currency_emoji: '🪙' };
  assert.equal(wager.checkBet(100, 1000, settings).ok, true);
  assert.equal(wager.checkBet(5, 1000, settings).ok, false);
  assert.equal(wager.checkBet(600, 1000, settings).ok, false);
  assert.equal(wager.checkBet(100, 50, settings).ok, false);
  assert.equal(wager.checkBet(0, 1000, settings).ok, false);
});

section('[アクション報告]');

await test('プリセット登録', async () => {
  for (const preset of act.PRESET_ACTIVITIES) await act.upsertActivity(db, G, preset);
  const list = await act.listActivities(db, G);
  assert.equal(list.length, act.PRESET_ACTIVITIES.length);
});

await test('更新は指定した項目だけ変わる', async () => {
  await act.upsertActivity(db, G, { name: '筋トレ', reward: 80 });
  const activity = await act.getActivity(db, G, '筋トレ');
  assert.equal(activity.reward, 80);
  assert.equal(activity.cooldown_sec, 21600);
  assert.equal(activity.emoji, '💪');
});

await test('クールダウン中は報告できない', async () => {
  const activity = await act.getActivity(db, G, '筋トレ');
  assert.equal((await act.canReport(db, G, A, activity, 'Asia/Tokyo')).ok, true);
  await act.logReport(db, G, A, '筋トレ', activity.reward);
  const gate = await act.canReport(db, G, A, activity, 'Asia/Tokyo');
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'cooldown');
  assert.ok(gate.retryAtMs > Date.now());
});

await test('1日の上限を超えると報告できない', async () => {
  const activity = await act.upsertActivity(db, G, { name: '早起き', daily_limit: 1, cooldown_sec: 0 });
  await act.logReport(db, G, B, '早起き', activity.reward);
  const gate = await act.canReport(db, G, B, activity, 'Asia/Tokyo');
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'daily');
  assert.equal(await act.countToday(db, G, B, '早起き', 'Asia/Tokyo'), 1);
});

await test('昨日の報告は今日の回数に含まれない', async () => {
  await db.run(
    'UPDATE activity_logs SET created_at = ?1 WHERE guild_id = ?2 AND user_id = ?3 AND activity = ?4',
    Date.now() - 36 * 3600 * 1000,
    G,
    B,
    '早起き',
  );
  assert.equal(await act.countToday(db, G, B, '早起き', 'Asia/Tokyo'), 0);
  const activity = await act.getActivity(db, G, '早起き');
  assert.equal((await act.canReport(db, G, B, activity, 'Asia/Tokyo')).ok, true);
});

await test('削除できる', async () => {
  assert.equal(await act.removeActivity(db, G, '自炊'), true);
  assert.equal(await act.removeActivity(db, G, '自炊'), false);
});

section('[連日ボーナス]');

const streak = await import(src('lib/streak.js'));

/** 「最後に報告した日」を n 日前に書き換えて、日をまたいだことにする。 */
async function pretendLastReportWas(daysAgo, userId = A) {
  const key = streak.dateKey('Asia/Tokyo', new Date(Date.now() - daysAgo * 86400 * 1000));
  await db.run('UPDATE streaks SET last_date = ?3 WHERE guild_id = ?1 AND user_id = ?2', G, userId, key);
}

await test('初めての報告で1日目になる', async () => {
  const result = await streak.touchStreak(db, G, A, 'Asia/Tokyo');
  assert.deepEqual(result, { current: 1, best: 1, isNewDay: true });
});

await test('同じ日に何度報告しても増えない', async () => {
  const result = await streak.touchStreak(db, G, A, 'Asia/Tokyo');
  assert.equal(result.current, 1);
  assert.equal(result.isNewDay, false, '同日は新しい日として数えない');
});

await test('翌日に報告すると2日目になる', async () => {
  await pretendLastReportWas(1);
  const result = await streak.touchStreak(db, G, A, 'Asia/Tokyo');
  assert.equal(result.current, 2);
  assert.equal(result.isNewDay, true);
});

await test('1日空くと1日目に戻り、最高記録は残る', async () => {
  await pretendLastReportWas(1);
  await streak.touchStreak(db, G, A, 'Asia/Tokyo'); // 3日目
  assert.equal((await streak.getStreak(db, G, A, 'Asia/Tokyo')).current, 3);

  await pretendLastReportWas(3);
  const result = await streak.touchStreak(db, G, A, 'Asia/Tokyo');
  assert.equal(result.current, 1, '途切れたのでやり直し');
  assert.equal(result.best, 3, '最高記録は残る');
});

await test('報告していない日が続くと連続は0と表示される', async () => {
  await pretendLastReportWas(5);
  const view = await streak.getStreak(db, G, A, 'Asia/Tokyo');
  assert.equal(view.current, 0);
  assert.equal(view.alive, false);
  assert.equal(view.best, 3);
});

await test('ちょうどその日数のときだけボーナスが出る', async () => {
  await streak.upsertStreakReward(db, G, 3, 300);
  const before = await eco.getBalance(db, G, A);
  assert.equal(await streak.payStreakBonus(db, G, A, 2), null, '2日目は対象外');
  assert.equal(await eco.getBalance(db, G, A), before);

  const paid = await streak.payStreakBonus(db, G, A, 3);
  assert.deepEqual(paid, { days: 3, reward: 300 });
  assert.equal(await eco.getBalance(db, G, A), before + 300);
});

await test('ボーナスの設定を変更・削除できる', async () => {
  await streak.upsertStreakReward(db, G, 3, 500);
  const rewards = await streak.listStreakRewards(db, G);
  assert.equal(rewards.length, 1, '同じ日数は上書きされる');
  assert.equal(rewards[0].reward, 500);
  assert.equal(await streak.removeStreakReward(db, G, 3), true);
  assert.equal((await streak.listStreakRewards(db, G)).length, 0);
});

section('[称号]');

const ach = await import(src('lib/achievements.js'));
const reporting = await import(src('lib/reporting.js'));

const ACH_USER = 'userAch';

await test('条件を満たすと自動で贈られ、ボーナスが入る', async () => {
  await ach.createAchievement(db, G, {
    name: '継続の鬼',
    emoji: '🔥',
    condition_type: 'total_reports',
    threshold: 2,
    reward: 1000,
  });
  const before = await eco.getBalance(db, G, ACH_USER);

  await act.logReport(db, G, ACH_USER, '早起き', 10);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), [], '1回では足りない');

  await act.logReport(db, G, ACH_USER, '早起き', 10);
  const unlocked = await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' });
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].name, '継続の鬼');
  assert.equal(await eco.getBalance(db, G, ACH_USER), before + 1000);
});

await test('同じ称号は二度もらえない', async () => {
  const before = await eco.getBalance(db, G, ACH_USER);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), []);
  assert.equal(await eco.getBalance(db, G, ACH_USER), before);
  assert.equal((await ach.earnedBy(db, G, ACH_USER)).length, 1);
});

await test('特定アクションの回数でも贈れる', async () => {
  await ach.createAchievement(db, G, {
    name: '筋トレ王',
    condition_type: 'activity_reports',
    threshold: 2,
    activity_name: '筋トレ',
    reward: 0,
  });
  await act.logReport(db, G, ACH_USER, '筋トレ', 80);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), []);
  await act.logReport(db, G, ACH_USER, '筋トレ', 80);
  const unlocked = await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' });
  assert.equal(unlocked[0].name, '筋トレ王');
});

await test('連続日数と所持金でも贈れる', async () => {
  await ach.createAchievement(db, G, { name: '鉄の意志', condition_type: 'streak', threshold: 3, reward: 0 });
  await ach.createAchievement(db, G, { name: '富豪', condition_type: 'balance', threshold: 100000, reward: 0 });

  const unlocked = await ach.evaluate(db, { guildId: G, userId: A, timezone: 'Asia/Tokyo' });
  const names = unlocked.map((a) => a.name);
  assert.ok(names.includes('鉄の意志'), '最高3日連続を達成済み');
  assert.ok(!names.includes('富豪'), '所持金は足りない');

  await eco.setBalance(db, G, A, 100000, 'test');
  const rich = await ach.evaluate(db, { guildId: G, userId: A, timezone: 'Asia/Tokyo' });
  assert.deepEqual(rich.map((a) => a.name), ['富豪']);
});

await test('削除すると獲得記録も消える', async () => {
  const all = await ach.listAchievements(db, G);
  const target = all.find((a) => a.name === '富豪');
  await ach.removeAchievement(db, G, target.id);
  assert.equal((await ach.listAchievements(db, G)).some((a) => a.name === '富豪'), false);
  assert.equal((await ach.earnedBy(db, G, A)).some((a) => a.name === '富豪'), false);
});

await test('報告すると連続日数・ボーナス・称号がまとめて処理される', async () => {
  const C = 'userC';
  await eco.setBalance(db, G, C, 0, 'test');
  await streak.upsertStreakReward(db, G, 1, 77);
  await ach.createAchievement(db, G, { name: '第一歩', condition_type: 'total_reports', threshold: 1, reward: 33 });

  const activity = await act.getActivity(db, G, 'ランニング');
  const result = await reporting.attemptReport(db, {
    guildId: G,
    userId: C,
    activity,
    timezone: 'Asia/Tokyo',
  });

  assert.equal(result.ok, true);
  assert.equal(result.streak.current, 1);
  assert.deepEqual(result.streakBonus, { days: 1, reward: 77 });
  assert.deepEqual(result.unlocked.map((a) => a.name), ['第一歩']);
  assert.equal(result.balance, activity.reward + 77 + 33, '報酬＋連日ボーナス＋称号ボーナス');
});

section('[ショップ]');

let item;
await test('出品できる', async () => {
  item = await shop.createItem(db, { guildId: G, sellerId: A, name: '肩たたき券', price: 200, stock: 2, description: 'テスト' });
  assert.equal(item.stock, 2);
  assert.equal(item.active, 1);
  assert.equal(await shop.countItems(db, G), 1);
});

await test('自分の出品は買えない', async () => {
  await assert.rejects(() => shop.purchase(db, G, item.id, A), (error) => error.code === 'own_item');
});

await test('購入で残高・在庫・履歴がすべて動く', async () => {
  await eco.setBalance(db, G, B, 500, 'test');
  const sellerBefore = await eco.getBalance(db, G, A);
  await shop.purchase(db, G, item.id, B);
  assert.equal(await eco.getBalance(db, G, B), 300);
  assert.equal(await eco.getBalance(db, G, A), sellerBefore + 200);
  const after = await shop.getItem(db, G, item.id);
  assert.equal(after.stock, 1);
  assert.equal(after.sold, 1);
  const owned = await shop.inventoryOf(db, G, B);
  assert.equal(owned[0].count, 1);
});

await test('最後の1つを買っても支払いと履歴が正しく残り、販売停止になる', async () => {
  const buyerBefore = await eco.getBalance(db, G, B);
  const sellerBefore = await eco.getBalance(db, G, A);
  await shop.purchase(db, G, item.id, B);
  const after = await shop.getItem(db, G, item.id);
  assert.equal(after.stock, 0);
  assert.equal(after.active, 0);
  assert.equal(after.sold, 2);
  assert.equal(await eco.getBalance(db, G, B), buyerBefore - 200, '買い手から引き落とされる');
  assert.equal(await eco.getBalance(db, G, A), sellerBefore + 200, '売り手に入金される');
  const purchases = await db.all('SELECT * FROM purchases WHERE item_id = ?1', item.id);
  assert.equal(purchases.length, 2, '購入履歴が2件');
  await assert.rejects(() => shop.purchase(db, G, item.id, B), (error) => error.code === 'inactive');
});

await test('残高不足の購入は何も変えない', async () => {
  const pricey = await shop.createItem(db, { guildId: G, sellerId: A, name: '高級品', price: 100000, stock: 1 });
  const buyerBefore = await eco.getBalance(db, G, B);
  const sellerBefore = await eco.getBalance(db, G, A);
  await assert.rejects(() => shop.purchase(db, G, pricey.id, B), (error) => error.code === 'insufficient');
  const after = await shop.getItem(db, G, pricey.id);
  assert.equal(after.stock, 1);
  assert.equal(after.sold, 0);
  assert.equal(after.active, 1);
  assert.equal(await eco.getBalance(db, G, B), buyerBefore);
  assert.equal(await eco.getBalance(db, G, A), sellerBefore);
  const purchases = await db.all('SELECT * FROM purchases WHERE item_id = ?1', pricey.id);
  assert.equal(purchases.length, 0, '購入履歴も残らない');
});

await test('在庫無制限は何度でも買える', async () => {
  const unlimited = await shop.createItem(db, { guildId: G, sellerId: A, name: '無限券', price: 10, stock: -1 });
  await eco.setBalance(db, G, B, 100, 'test');
  await shop.purchase(db, G, unlimited.id, B);
  await shop.purchase(db, G, unlimited.id, B);
  const after = await shop.getItem(db, G, unlimited.id);
  assert.equal(after.sold, 2);
  assert.equal(after.active, 1);
  assert.equal(await eco.getBalance(db, G, B), 80);
});

await test('売上が集計される', async () => {
  const sales = await shop.salesOf(db, G, A);
  assert.equal(sales.reduce((sum, row) => sum + row.count, 0), 4);
});

await test('取り下げると一覧から消える', async () => {
  const listed = (await shop.listItems(db, G)).length;
  const target = (await shop.listItems(db, G))[0];
  await shop.setActive(db, G, target.id, false);
  assert.equal((await shop.listItems(db, G)).length, listed - 1);
});

await test('別サーバーの商品は見えない', async () => {
  assert.equal(await shop.getItem(db, 'guild2', item.id), null);
  assert.equal(await shop.countItems(db, 'guild2'), 0);
});

section('[じゃんけん]');

await test('勝敗判定', () => {
  assert.equal(rps.judge('rock', 'scissors'), 'challenger');
  assert.equal(rps.judge('scissors', 'rock'), 'opponent');
  assert.equal(rps.judge('paper', 'rock'), 'challenger');
  assert.equal(rps.judge('rock', 'paper'), 'opponent');
  assert.equal(rps.judge('paper', 'paper'), 'draw');
});

await test('状態遷移（二重開始・出し直しを防ぐ）', async () => {
  await rps.createMatch(db, { id: 'm1', guildId: G, channelId: 'c', challengerId: A, opponentId: B, bet: 10 });
  assert.equal((await rps.getMatch(db, 'm1')).status, 'pending');
  assert.equal(await rps.markPlaying(db, 'm1'), true);
  assert.equal(await rps.markPlaying(db, 'm1'), false);
  assert.equal(await rps.setHand(db, 'm1', 'challenger', 'rock'), true);
  assert.equal(await rps.setHand(db, 'm1', 'challenger', 'paper'), false);
  assert.equal((await rps.getMatch(db, 'm1')).challenger_hand, 'rock');
});

await test('あいこで次ラウンドに進むと手がリセットされる', async () => {
  await rps.setHand(db, 'm1', 'opponent', 'rock');
  const next = await rps.nextRound(db, 'm1');
  assert.equal(next.round, 2);
  assert.equal(next.challenger_hand, null);
  assert.equal(next.opponent_hand, null);
});

await test('時間切れの対戦を返金して中止する', async () => {
  await db.run('UPDATE rps_matches SET expires_at = ?1 WHERE id = ?2', Date.now() - 1000, 'm1');
  const beforeA = await eco.getBalance(db, G, A);
  const beforeB = await eco.getBalance(db, G, B);
  const handled = await rps.cancelExpired(db);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].refunded, true);
  assert.equal(await eco.getBalance(db, G, A), beforeA + 10);
  assert.equal(await eco.getBalance(db, G, B), beforeB + 10);
  assert.equal((await rps.getMatch(db, 'm1')).status, 'cancelled');
  assert.equal((await rps.cancelExpired(db)).length, 0, '二重返金しない');
});

await test('まだ期限が来ていない対戦は触らない', async () => {
  await rps.createMatch(db, { id: 'm2', guildId: G, channelId: 'c', challengerId: A, opponentId: B, bet: 5 });
  assert.equal((await rps.cancelExpired(db)).length, 0);
  assert.equal((await rps.getMatch(db, 'm2')).status, 'pending');
});

section('[スロット]');

await test('出目は3つ、配当は倍率どおり', () => {
  const symbols = new Set(slot.SLOT_SYMBOLS.map((s) => s.symbol));
  for (let i = 0; i < 500; i++) {
    const result = slot.spin();
    assert.equal(result.reels.length, 3);
    for (const symbol of result.reels) assert.ok(symbols.has(symbol));
    if (result.kind === 'triple') assert.ok(result.reels.every((s) => s === result.symbol));
    if (result.kind === 'lose') assert.equal(result.multiplier, 0);
    else assert.ok(result.multiplier > 0);
  }
});

await test('還元率が 85〜97% に収まる', () => {
  let payout = 0;
  const rounds = 300000;
  for (let i = 0; i < rounds; i++) payout += slot.spin().multiplier;
  const rtp = payout / rounds;
  assert.ok(rtp > 0.85 && rtp < 0.97, `RTP = ${(rtp * 100).toFixed(2)}%`);
});

section('[表示ヘルパー]');

await test('金額表示', () => {
  assert.equal(fmt.coins(1234, { currency_emoji: '🪙', currency_name: 'コイン' }), '🪙 **1,234** コイン');
});

await test('時間表示', () => {
  assert.equal(fmt.duration(30), '30秒');
  assert.equal(fmt.duration(90), '1分30秒');
  assert.equal(fmt.duration(3600), '1時間');
  assert.equal(fmt.duration(21600), '6時間');
  assert.equal(fmt.duration(90000), '1日1時間');
});

await test('今日の開始時刻がJST基準', () => {
  const start = fmt.startOfToday('Asia/Tokyo');
  assert.match(new Date(start + 9 * 3600 * 1000).toISOString(), /T00:00:00/);
  assert.ok(Date.now() - start < 24 * 3600 * 1000);
});

section('[Discord との受け答え]');

await test('Discord の署名を検証できる', async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keyPair.publicKey)).toString('hex');
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString('hex');

  const makeRequest = (sig) =>
    new Request('https://example.invalid/', {
      method: 'POST',
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': timestamp },
      body,
    });

  assert.equal((await verify.verifyRequest(makeRequest(signature), publicKey)).valid, true);
  const tampered = `${signature.slice(0, 126)}${signature.slice(126) === 'ff' ? '00' : 'ff'}`;
  assert.equal((await verify.verifyRequest(makeRequest(tampered), publicKey)).valid, false);
  assert.equal((await verify.verifyRequest(makeRequest('zz'), publicKey)).valid, false);
});

await test('埋め込みとボタンの JSON が Discord の形になる', () => {
  const built = builders.embed({ color: 1, title: 't', description: undefined, image: 'https://x/y.png' });
  assert.deepEqual(built, { color: 1, title: 't', image: { url: 'https://x/y.png' } });
  const btn = builders.button('m:home:open', 'ホーム', { emoji: '🏠' });
  assert.equal(btn.type, 2);
  assert.equal(btn.custom_id, 'm:home:open');
  assert.deepEqual(btn.emoji, { name: '🏠' });
  const select = builders.stringSelect('m:shop:view', '選ぶ', [{ label: 'a', value: 1 }]);
  assert.equal(select.type, 1);
  assert.equal(select.components[0].options[0].value, '1');
});

runner.done();
db.close();
