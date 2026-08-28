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

section('[連日ボーナス（アクションごと）]');

const streak = await import(src('lib/streak.js'));

/** そのアクションを「最後に報告した日」を n 日前にして、日をまたいだことにする。 */
async function pretendLastReportWas(daysAgo, activity, userId = A) {
  const key = streak.dateKey('Asia/Tokyo', new Date(Date.now() - daysAgo * 86400 * 1000));
  await db.run(
    'UPDATE streaks SET last_date = ?4 WHERE guild_id = ?1 AND user_id = ?2 AND activity = ?3',
    G,
    userId,
    activity,
    key,
  );
}

await test('初めての報告で1日目になる', async () => {
  const result = await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo');
  assert.deepEqual(result, { current: 1, best: 1, isNewDay: true });
});

await test('同じ日に何度報告しても増えない', async () => {
  const result = await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo');
  assert.equal(result.current, 1);
  assert.equal(result.isNewDay, false);
});

await test('アクションごとに別々に数える', async () => {
  await streak.touchStreak(db, G, A, '勉強', 'Asia/Tokyo');
  await pretendLastReportWas(1, '筋トレ');
  await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo');

  assert.equal((await streak.getStreak(db, G, A, '筋トレ', 'Asia/Tokyo')).current, 2);
  assert.equal((await streak.getStreak(db, G, A, '勉強', 'Asia/Tokyo')).current, 1, '勉強は別勘定');
});

await test('1日空くと1日目に戻り、最高記録は残る', async () => {
  await pretendLastReportWas(1, '筋トレ');
  await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo'); // 3日目
  assert.equal((await streak.getStreak(db, G, A, '筋トレ', 'Asia/Tokyo')).current, 3);

  await pretendLastReportWas(3, '筋トレ');
  const result = await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo');
  assert.equal(result.current, 1, '途切れたのでやり直し');
  assert.equal(result.best, 3, '最高記録は残る');
});

await test('報告していない日が続くと連続は0と表示される', async () => {
  await pretendLastReportWas(5, '筋トレ');
  const view = await streak.getStreak(db, G, A, '筋トレ', 'Asia/Tokyo');
  assert.equal(view.current, 0);
  assert.equal(view.alive, false);
  assert.equal(view.best, 3);
});

await test('続いているものから順に並べて取れる', async () => {
  await streak.touchStreak(db, G, A, '筋トレ', 'Asia/Tokyo');
  const list = await streak.allStreaks(db, G, A, 'Asia/Tokyo');
  assert.equal(list.length, 2);
  assert.ok(list.every((entry) => entry.current >= 0));
  assert.equal(list.filter((entry) => entry.activity === '勉強')[0].current, 1);
});

await test('範囲の中なら毎日もらえる', async () => {
  await streak.upsertStreakReward(db, G, '筋トレ', 3, 6, 50);
  const before = await eco.getBalance(db, G, A);

  assert.equal(await streak.payStreakBonus(db, G, A, '筋トレ', 2), null, '範囲の手前は対象外');
  assert.equal(await streak.payStreakBonus(db, G, A, '筋トレ', 7), null, '範囲を過ぎたら対象外');
  assert.equal(await streak.payStreakBonus(db, G, A, '勉強', 4), null, '別のアクションは対象外');
  assert.equal(await eco.getBalance(db, G, A), before);

  for (const day of [3, 4, 5, 6]) {
    assert.deepEqual(await streak.payStreakBonus(db, G, A, '筋トレ', day), { days: day, reward: 50 });
  }
  assert.equal(await eco.getBalance(db, G, A), before + 200, '4日ぶん毎日もらえる');
});

await test('上限を空けると、それ以降ずっともらえる', async () => {
  await streak.upsertStreakReward(db, G, '筋トレ', 14, 0, 200);
  for (const day of [14, 100, 3650]) {
    assert.deepEqual(await streak.payStreakBonus(db, G, A, '筋トレ', day), { days: day, reward: 200 });
  }
});

await test('範囲が重なったら、細かいほう（開始が後のほう）が使われる', async () => {
  for (const reward of await streak.listStreakRewards(db, G, '筋トレ')) {
    await streak.removeStreakReward(db, G, '筋トレ', reward.from_days);
  }
  await streak.upsertStreakReward(db, G, '筋トレ', 1, 0, 10); // 1日目以降ずっと
  await streak.upsertStreakReward(db, G, '筋トレ', 7, 13, 100); // その中の一部を上書き

  assert.equal((await streak.findStreakReward(db, G, '筋トレ', 5)).reward, 10);
  assert.equal((await streak.findStreakReward(db, G, '筋トレ', 7)).reward, 100);
  assert.equal((await streak.findStreakReward(db, G, '筋トレ', 13)).reward, 100);
  assert.equal((await streak.findStreakReward(db, G, '筋トレ', 14)).reward, 10, '範囲を抜けたら広いほうに戻る');
});

await test('設定の上書き・削除・アクション削除時の片付け', async () => {
  await streak.upsertStreakReward(db, G, '筋トレ', 3, 6, 500);
  const own = await streak.listStreakRewards(db, G, '筋トレ');
  assert.equal(own.filter((reward) => reward.from_days === 3).length, 1, '同じ開始日は上書き');
  assert.equal(own.find((reward) => reward.from_days === 3).reward, 500);

  await streak.upsertStreakReward(db, G, '勉強', 7, 0, 100);
  assert.equal((await streak.listStreakRewards(db, G, '勉強')).length, 1);

  assert.equal(await streak.removeStreakReward(db, G, '筋トレ', 3), true);
  await streak.removeStreakRewardsFor(db, G, '勉強');
  assert.equal((await streak.listStreakRewards(db, G, '勉強')).length, 0);

  for (const reward of await streak.listStreakRewards(db, G, '筋トレ')) {
    await streak.removeStreakReward(db, G, '筋トレ', reward.from_days);
  }
  assert.equal((await streak.listStreakRewards(db, G)).length, 0);
});

await test('説明が読める日本語になる', () => {
  const settings = { currency_emoji: '🪙', currency_name: 'コイン' };
  assert.equal(streak.describeStreakReward({ from_days: 3, to_days: 6, reward: 50 }, settings), '3〜6日目 は毎日 🪙50');
  assert.equal(streak.describeStreakReward({ from_days: 14, to_days: 0, reward: 200 }, settings), '14日目以降 は毎日 🪙200');
});

section('[称号]');

const ach = await import(src('lib/achievements.js'));
const reporting = await import(src('lib/reporting.js'));
const ACH_USER = 'userAch';

await test('アクションの回数で贈られ、ボーナスが入る', async () => {
  await ach.createAchievement(db, G, {
    name: '筋トレ王',
    emoji: '💪',
    condition_type: 'activity_count',
    threshold: 2,
    activity_name: '筋トレ',
    reward: 1000,
  });
  const before = await eco.getBalance(db, G, ACH_USER);

  await act.logReport(db, G, ACH_USER, '筋トレ', 80);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), [], '1回では足りない');

  await act.logReport(db, G, ACH_USER, '筋トレ', 80);
  const unlocked = await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' });
  assert.deepEqual(unlocked.map((a) => a.name), ['筋トレ王']);
  assert.equal(await eco.getBalance(db, G, ACH_USER), before + 1000);
});

await test('別のアクションの回数は数えない', async () => {
  await ach.createAchievement(db, G, {
    name: '勉強王',
    condition_type: 'activity_count',
    threshold: 2,
    activity_name: '勉強',
    reward: 0,
  });
  await act.logReport(db, G, ACH_USER, '早起き', 10);
  await act.logReport(db, G, ACH_USER, '早起き', 10);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), []);
});

await test('同じ称号は二度もらえない', async () => {
  const before = await eco.getBalance(db, G, ACH_USER);
  assert.deepEqual(await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' }), []);
  assert.equal(await eco.getBalance(db, G, ACH_USER), before);
  assert.equal((await ach.earnedBy(db, G, ACH_USER)).length, 1);
});

await test('アクションの連続日数でも贈れる', async () => {
  await ach.createAchievement(db, G, {
    name: '鉄の意志',
    condition_type: 'activity_streak',
    threshold: 3,
    activity_name: '筋トレ',
    reward: 0,
  });
  const unlocked = await ach.evaluate(db, { guildId: G, userId: A, timezone: 'Asia/Tokyo' });
  assert.ok(unlocked.map((a) => a.name).includes('鉄の意志'), '筋トレの最高記録が3日');

  const other = await ach.evaluate(db, { guildId: G, userId: ACH_USER, timezone: 'Asia/Tokyo' });
  assert.equal(other.map((a) => a.name).includes('鉄の意志'), false, '連続していない人はもらえない');
});

await test('合計回数と所持金でも贈れる', async () => {
  await ach.createAchievement(db, G, { name: '富豪', condition_type: 'balance', threshold: 100000, reward: 0 });
  assert.equal(
    (await ach.evaluate(db, { guildId: G, userId: A, timezone: 'Asia/Tokyo' })).length,
    0,
    '所持金が足りない',
  );
  await eco.setBalance(db, G, A, 100000, 'test');
  const rich = await ach.evaluate(db, { guildId: G, userId: A, timezone: 'Asia/Tokyo' });
  assert.deepEqual(rich.map((a) => a.name), ['富豪']);
});

await test('称号を1つ選んで名前の横に出せる', async () => {
  const earned = await ach.earnedBy(db, G, A);
  const target = earned.find((a) => a.name === '富豪');
  assert.equal(await ach.equipTitle(db, G, A, target.id), true);

  const equipped = await ach.equippedTitle(db, G, A);
  assert.equal(equipped.name, '富豪');
  assert.equal(ach.titleTag(equipped), '🏅富豪');

  const map = await ach.equippedTitles(db, G, [A, B]);
  assert.equal(map.get(A).name, '富豪');
  assert.equal(map.has(B), false);
});

await test('持っていない称号は装備できない', async () => {
  const all = await ach.listAchievements(db, G);
  const notOwned = all.find((a) => a.name === '勉強王');
  assert.equal(await ach.equipTitle(db, G, A, notOwned.id), false);
  assert.equal((await ach.equippedTitle(db, G, A)).name, '富豪', '前のままで変わらない');
});

await test('外すこともできる', async () => {
  assert.equal(await ach.equipTitle(db, G, A, null), true);
  assert.equal(await ach.equippedTitle(db, G, A), null);
  assert.equal(ach.titleTag(null), '');
});

await test('削除すると獲得記録と装備も消える', async () => {
  const all = await ach.listAchievements(db, G);
  const target = all.find((a) => a.name === '富豪');
  await ach.equipTitle(db, G, A, target.id);
  await ach.removeAchievement(db, G, target.id);

  assert.equal((await ach.listAchievements(db, G)).some((a) => a.name === '富豪'), false);
  assert.equal((await ach.earnedBy(db, G, A)).some((a) => a.name === '富豪'), false);
  assert.equal(await ach.equippedTitle(db, G, A), null, '装備も外れる');
});

await test('報告すると連続日数・ボーナス・称号がまとめて処理される', async () => {
  const C = 'userC';
  await eco.setBalance(db, G, C, 0, 'test');
  await streak.upsertStreakReward(db, G, 'ランニング', 1, 0, 77);
  await ach.createAchievement(db, G, {
    name: '第一歩',
    condition_type: 'activity_count',
    threshold: 1,
    activity_name: 'ランニング',
    reward: 33,
  });

  const activity = await act.getActivity(db, G, 'ランニング');
  const result = await reporting.attemptReport(db, { guildId: G, userId: C, activity, timezone: 'Asia/Tokyo' });

  assert.equal(result.ok, true);
  assert.equal(result.streak.current, 1);
  assert.deepEqual(result.streakBonus, { days: 1, reward: 77 });
  assert.deepEqual(result.unlocked.map((a) => a.name), ['第一歩']);
  assert.equal(result.balance, activity.reward + 77 + 33, '報酬＋連日ボーナス＋称号ボーナス');
});

section('[ランキングの集計]');

const ranking = await import(src('lib/ranking.js'));

await test('総コイン数で並ぶ', async () => {
  const rows = await ranking.computeRanking(db, { guildId: G, metric: 'balance', limit: 3, timezone: 'Asia/Tokyo' });
  assert.ok(rows.length > 0);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].value >= rows[i].value, '降順');
});

await test('期間内に稼いだコインで並ぶ', async () => {
  const since = ranking.startOfDay('Asia/Tokyo');
  const rows = await ranking.computeRanking(db, { guildId: G, metric: 'earned', since, limit: 5, timezone: 'Asia/Tokyo' });
  assert.ok(rows.every((row) => row.value > 0), '増えた分だけを数える');
});

await test('アクションの回数で並ぶ（対象を絞れる）', async () => {
  const all = await ranking.computeRanking(db, {
    guildId: G,
    metric: 'activity_total',
    limit: 10,
    timezone: 'Asia/Tokyo',
  });
  const onlyMuscle = await ranking.computeRanking(db, {
    guildId: G,
    metric: 'activity_total',
    activityName: '筋トレ',
    limit: 10,
    timezone: 'Asia/Tokyo',
  });
  const totalAll = all.reduce((sum, row) => sum + row.value, 0);
  const totalMuscle = onlyMuscle.reduce((sum, row) => sum + row.value, 0);
  assert.ok(totalMuscle > 0);
  assert.ok(totalAll > totalMuscle, '絞ると少なくなる');
});

await test('連続記録は続いている人だけ並ぶ', async () => {
  const rows = await ranking.computeRanking(db, {
    guildId: G,
    metric: 'activity_streak',
    activityName: '筋トレ',
    limit: 10,
    timezone: 'Asia/Tokyo',
  });
  assert.ok(rows.every((row) => row.value > 0));
  assert.ok(rows.some((row) => row.user_id === A));
});

await test('週の始まりは月曜', () => {
  const monday = new Date('2026-08-24T03:00:00Z'); // 月曜正午 JST
  const sunday = new Date('2026-08-30T03:00:00Z'); // 日曜正午 JST
  assert.equal(ranking.startOfWeek('Asia/Tokyo', monday), ranking.startOfDay('Asia/Tokyo', monday));
  const weekStart = ranking.startOfWeek('Asia/Tokyo', sunday);
  assert.equal((ranking.startOfDay('Asia/Tokyo', sunday) - weekStart) / 86400000, 6, '日曜は週の7日目');
});

await test('見出しが読める日本語になる', () => {
  assert.equal(ranking.rankingTitle({ metric: 'balance' }), '総コイン数ランキング');
  assert.equal(ranking.rankingTitle({ metric: 'earned', period: 'week' }), '稼いだコインランキング（今週）');
  assert.equal(
    ranking.rankingTitle({ metric: 'activity_streak', activityName: '筋トレ' }),
    '「筋トレ」の連続記録ランキング',
  );
});

section('[定期発表]');

const announcements = await import(src('lib/announcements.js'));

await test('作成・一覧・停止・削除ができる', async () => {
  const created = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1',
    metric: 'balance',
    frequency: 'daily',
    hour: 9,
    topN: 3,
    prize: 100,
  });
  assert.equal(created.enabled, 1);
  assert.equal((await announcements.listAnnouncements(db, G)).length, 1);

  const toggled = await announcements.toggleAnnouncement(db, G, created.id);
  assert.equal(toggled.enabled, 0);
  await announcements.toggleAnnouncement(db, G, created.id);

  assert.match(announcements.describeSchedule(created), /毎日 9時/);
  assert.equal(await announcements.removeAnnouncement(db, G, created.id), true);
  assert.equal((await announcements.listAnnouncements(db, G)).length, 0);
});

await test('その時刻になったものだけ拾い、同じ日に二度出さない', async () => {
  const noon = new Date('2026-08-27T03:00:00Z'); // JST 12時（木曜）
  const morning = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1', metric: 'balance', frequency: 'daily', hour: 9, topN: 3, prize: 0,
  });
  const atNoon = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1', metric: 'balance', frequency: 'daily', hour: 12, topN: 3, prize: 0,
  });

  const due = await announcements.dueAnnouncements(db, 'Asia/Tokyo', noon);
  assert.deepEqual(due.map((row) => row.id), [atNoon.id], '12時のものだけ');

  await announcements.markAnnounced(db, atNoon.id, streak.dateKey('Asia/Tokyo', noon));
  assert.deepEqual(await announcements.dueAnnouncements(db, 'Asia/Tokyo', noon), [], '同じ日はもう出さない');

  await announcements.removeAnnouncement(db, G, morning.id);
  await announcements.removeAnnouncement(db, G, atNoon.id);
});

await test('毎週の設定は曜日が合った日だけ出る', async () => {
  const thursday = new Date('2026-08-27T03:00:00Z'); // 木曜 JST 12時
  const weekly = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1', metric: 'balance', frequency: 'weekly', weekday: 1, hour: 12, topN: 3, prize: 0,
  });
  assert.deepEqual(await announcements.dueAnnouncements(db, 'Asia/Tokyo', thursday), [], '月曜設定は木曜に出ない');

  const monday = new Date('2026-08-31T03:00:00Z'); // 月曜 JST 12時
  const due = await announcements.dueAnnouncements(db, 'Asia/Tokyo', monday);
  assert.deepEqual(due.map((row) => row.id), [weekly.id]);
  await announcements.removeAnnouncement(db, G, weekly.id);
});

await test('発表の内容が作られ、1位に賞金が渡る', async () => {
  const announcement = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1', metric: 'balance', frequency: 'daily', hour: 9, topN: 3, prize: 500,
  });
  const settings = await eco.getSettings(db, G);
  const top = (await ranking.computeRanking(db, { guildId: G, metric: 'balance', limit: 1, timezone: 'Asia/Tokyo' }))[0];
  const before = await eco.getBalance(db, G, top.user_id);

  const built = await announcements.buildAnnouncement(db, announcement, { settings, timezone: 'Asia/Tokyo' });
  assert.match(built.embed.title, /総コイン数ランキング/);
  assert.match(built.embed.description, /🥇/);
  assert.deepEqual(built.winners, [top.user_id]);
  assert.equal(await eco.getBalance(db, G, top.user_id), before + 500);
  await announcements.removeAnnouncement(db, G, announcement.id);
});

await test('対象が誰もいなければ何も作らない', async () => {
  const announcement = await announcements.createAnnouncement(db, G, {
    channelId: 'chan1', metric: 'activity_streak', activityName: '存在しない', frequency: 'daily', hour: 9, topN: 3, prize: 0,
  });
  const settings = await eco.getSettings(db, G);
  assert.equal(await announcements.buildAnnouncement(db, announcement, { settings, timezone: 'Asia/Tokyo' }), null);
  await announcements.removeAnnouncement(db, G, announcement.id);
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
  const next = await rps.nextRound(db, 'm1', 1);
  assert.equal(next.round, 2);
  assert.equal(next.challenger_hand, null);
  assert.equal(next.opponent_hand, null);
  assert.equal(await rps.nextRound(db, 'm1', 1), null, '同じラウンドを二度は進められない');
});

await test('決着は先に取った1つだけが確定できる', async () => {
  await rps.setHand(db, 'm1', 'challenger', 'rock');
  await rps.setHand(db, 'm1', 'opponent', 'scissors');
  assert.equal(await rps.finishMatch(db, 'm1'), true);
  assert.equal(await rps.finishMatch(db, 'm1'), false, '二重に確定できない');
  assert.equal((await rps.getMatch(db, 'm1')).status, 'done');
  // 後続のテストのために元に戻す
  await rps.setStatus(db, 'm1', 'playing');
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

section('[ハイ&ロー]');

const hl = await import(src('lib/highlow.js'));

await test('倍率は当たりにくい予想ほど高い', () => {
  assert.ok(hl.stepMultiplier(2, 'low') > hl.stepMultiplier(2, 'high'), '2でLOWは高倍率');
  assert.ok(hl.stepMultiplier(12, 'high') > hl.stepMultiplier(12, 'low'), '12でHIGHは高倍率');
  assert.equal(hl.stepMultiplier(7, 'high'), hl.stepMultiplier(7, 'low'), '7は五分五分');
});

await test('端のカードでは片方を選べない', () => {
  assert.equal(hl.canChoose(1, 'low'), false);
  assert.equal(hl.canChoose(13, 'high'), false);
  assert.equal(hl.canChoose(1, 'high'), true);
});

await test('勝敗と引き分けの判定', () => {
  assert.equal(hl.judge({ rank: 5 }, { rank: 9 }, 'high'), 'win');
  assert.equal(hl.judge({ rank: 5 }, { rank: 2 }, 'high'), 'lose');
  assert.equal(hl.judge({ rank: 5 }, { rank: 2 }, 'low'), 'win');
  assert.equal(hl.judge({ rank: 5 }, { rank: 5 }, 'high'), 'draw');
});

await test('倍率は掛け算で伸び、上限で頭打ちになる', () => {
  assert.equal(hl.multiply(1, 1.84), 1.84);
  assert.equal(hl.multiply(1.84, 2), 3.68);
  assert.equal(hl.payout(100, 3.68), 368);
  assert.equal(hl.payout(100, hl.MAX_MULTIPLIER * 2), 100 * hl.MAX_MULTIPLIER, '上限を超えて払わない');
});

await test('還元率は「1回で降りると約97%、粘るほど下がる」', () => {
  const simulate = (maxSteps) => {
    let staked = 0;
    let returned = 0;
    for (let game = 0; game < 120000; game++) {
      staked += 100;
      let card = hl.drawCard();
      let multiplier = 1;
      let steps = 0;
      while (steps < maxSteps && multiplier < hl.MAX_MULTIPLIER) {
        const chance = hl.chances(card.rank);
        let choice = chance.high >= chance.low ? 'high' : 'low';
        if (!hl.canChoose(card.rank, choice)) choice = choice === 'high' ? 'low' : 'high';
        const step = hl.stepMultiplier(card.rank, choice);
        const next = hl.drawCard();
        const result = hl.judge(card, next, choice);
        card = next;
        if (result === 'draw') continue;
        if (result === 'lose') { multiplier = 0; break; }
        multiplier = hl.multiply(multiplier, step);
        steps++;
      }
      returned += hl.payout(100, multiplier);
    }
    return returned / staked;
  };
  const once = simulate(1);
  const thrice = simulate(3);
  assert.ok(once > 0.94 && once < 0.99, `1回で降りる: ${(once * 100).toFixed(1)}%`);
  assert.ok(thrice > 0.88 && thrice < 0.94, `3連勝狙い: ${(thrice * 100).toFixed(1)}%`);
  assert.ok(once > thrice, '粘るほど不利になる');
});

section('[チンチロ]');

const dice = await import(src('lib/dice.js'));

await test('役の判定', () => {
  assert.equal(dice.evaluate([1, 1, 1]).kind, 'pinzoro');
  assert.equal(dice.evaluate([4, 4, 4]).kind, 'zorome');
  assert.equal(dice.evaluate([6, 4, 5]).kind, 'shigoro');
  assert.equal(dice.evaluate([2, 1, 3]).kind, 'hifumi');
  assert.equal(dice.evaluate([3, 3, 6]).kind, 'me');
  assert.equal(dice.evaluate([3, 3, 6]).value, 6, '残りの1つが出目');
  assert.equal(dice.evaluate([2, 4, 6]).kind, 'none');
});

await test('役の格で勝敗と倍率が決まる', () => {
  const pinzoro = dice.evaluate([1, 1, 1]);
  const zorome = dice.evaluate([5, 5, 5]);
  const me6 = dice.evaluate([2, 2, 6]);
  const me3 = dice.evaluate([2, 2, 3]);

  assert.deepEqual(
    { winner: dice.compare(pinzoro, zorome).winner, multiplier: dice.compare(pinzoro, zorome).multiplier },
    { winner: 'challenger', multiplier: 5 },
  );
  assert.equal(dice.compare(zorome, me6).multiplier, 3);
  assert.equal(dice.compare(me6, me3).winner, 'challenger', '出目が大きい方が勝ち');
  assert.equal(dice.compare(me3, me6).winner, 'opponent', '弱い方が挑戦者なら受け手の勝ち');
  assert.equal(dice.compare(me6, me3).multiplier, 1);
  assert.equal(dice.compare(me6, dice.evaluate([3, 3, 6])).winner, 'draw', '同じ出目は引き分け');
});

await test('ヒフミは相手の役に関係なく負けて2倍払い', () => {
  const hifumi = dice.evaluate([1, 2, 3]);
  const none = dice.evaluate([2, 4, 6]);
  const pinzoro = dice.evaluate([1, 1, 1]);

  assert.deepEqual(dice.compare(hifumi, none), { winner: 'opponent', multiplier: 2, reason: 'ヒフミは2倍払い' });
  assert.equal(dice.compare(pinzoro, hifumi).winner, 'challenger');
  assert.equal(dice.compare(pinzoro, hifumi).multiplier, 2, 'ヒフミ相手は2倍（ピンゾロの5倍ではない）');
  assert.equal(dice.compare(hifumi, hifumi).winner, 'draw');
});

await test('役が出るまで最大3回振る', () => {
  for (let i = 0; i < 2000; i++) {
    const { throws, hand } = dice.rollHand();
    assert.ok(throws.length >= 1 && throws.length <= dice.MAX_THROWS);
    if (throws.length < dice.MAX_THROWS) assert.notEqual(hand.kind, 'none', '役が出たらそこで止まる');
    assert.deepEqual(hand.dice, throws[throws.length - 1]);
  }
});

const chinchiro = await import(src('lib/chinchiro.js'));

await test('動く最大額を預かるので払えない状況が起きない', async () => {
  assert.equal(chinchiro.escrowFor(100), 500, '賭け金の5倍');

  const P1 = 'ccA';
  const P2 = 'ccB';
  await eco.setBalance(db, G, P1, 1000, 'test');
  await eco.setBalance(db, G, P2, 1000, 'test');
  const match = await chinchiro.createMatch(db, {
    id: 'cc1', guildId: G, channelId: 'c', challengerId: P1, opponentId: P2, bet: 100,
  });
  assert.equal(match.escrow, 500);

  assert.equal(await eco.withdraw(db, G, P1, match.escrow, 'test'), true);
  assert.equal(await eco.withdraw(db, G, P2, match.escrow, 'test'), true);
  assert.equal(await eco.getBalance(db, G, P1), 500);

  // 挑戦者が ×3 で勝った場合
  await chinchiro.settle(db, match, 'challenger', 3);
  assert.equal(await eco.getBalance(db, G, P1), 1300, '預かり返却＋300');
  assert.equal(await eco.getBalance(db, G, P2), 700, '預かりから300引かれて返却');
});

await test('最大倍率で決着しても払いきれる', async () => {
  const P1 = 'ccC';
  const P2 = 'ccD';
  await eco.setBalance(db, G, P1, 500, 'test');
  await eco.setBalance(db, G, P2, 500, 'test');
  const match = await chinchiro.createMatch(db, {
    id: 'cc2', guildId: G, channelId: 'c', challengerId: P1, opponentId: P2, bet: 100,
  });
  await eco.withdraw(db, G, P1, match.escrow, 'test');
  await eco.withdraw(db, G, P2, match.escrow, 'test');
  assert.equal(await eco.getBalance(db, G, P2), 0, '全額預けた状態');

  await chinchiro.settle(db, match, 'challenger', dice.MAX_MULTIPLIER);
  assert.equal(await eco.getBalance(db, G, P1), 1000, '相手の全額を受け取れる');
  assert.equal(await eco.getBalance(db, G, P2), 0, 'マイナスにならない');
});

await test('引き分けなら預かった額がそのまま返る', async () => {
  const P1 = 'ccE';
  const P2 = 'ccF';
  await eco.setBalance(db, G, P1, 1000, 'test');
  await eco.setBalance(db, G, P2, 1000, 'test');
  const match = await chinchiro.createMatch(db, {
    id: 'cc3', guildId: G, channelId: 'c', challengerId: P1, opponentId: P2, bet: 200,
  });
  await eco.withdraw(db, G, P1, match.escrow, 'test');
  await eco.withdraw(db, G, P2, match.escrow, 'test');
  await chinchiro.settle(db, match, 'draw', 0);
  assert.equal(await eco.getBalance(db, G, P1), 1000);
  assert.equal(await eco.getBalance(db, G, P2), 1000);
});

await test('決着は先に取った1つだけ、時間切れは返金される', async () => {
  const match = await chinchiro.createMatch(db, {
    id: 'cc4', guildId: G, channelId: 'c', challengerId: 'ccE', opponentId: 'ccF', bet: 100,
  });
  assert.equal(await chinchiro.markPlaying(db, 'cc4'), true);
  assert.equal(await chinchiro.markPlaying(db, 'cc4'), false, '二重開始できない');
  assert.equal(await chinchiro.finishMatch(db, 'cc4'), true);
  assert.equal(await chinchiro.finishMatch(db, 'cc4'), false, '二重精算できない');

  const expiring = await chinchiro.createMatch(db, {
    id: 'cc5', guildId: G, channelId: 'c', challengerId: 'ccE', opponentId: 'ccF', bet: 100,
  });
  await chinchiro.markPlaying(db, 'cc5');
  await eco.withdraw(db, G, 'ccE', expiring.escrow, 'test');
  await eco.withdraw(db, G, 'ccF', expiring.escrow, 'test');
  const before = await eco.getBalance(db, G, 'ccE');

  await db.run('UPDATE chinchiro_matches SET expires_at = ?1 WHERE id = ?2', Date.now() - 1000, 'cc5');
  const handled = await chinchiro.cancelExpired(db);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].refunded, true);
  assert.equal(await eco.getBalance(db, G, 'ccE'), before + expiring.escrow);
  assert.equal((await chinchiro.cancelExpired(db)).length, 0, '二重返金しない');
});

await test('順番に振るので同じ人が続けて振れない', async () => {
  await chinchiro.createMatch(db, {
    id: 'cc6', guildId: G, channelId: 'c', challengerId: 'ccE', opponentId: 'ccF', bet: 100,
  });
  await chinchiro.markPlaying(db, 'cc6');
  assert.equal(await chinchiro.recordRoll(db, 'cc6', 'opponent', [[1, 2, 4]]), false, '先攻より先には振れない');
  assert.equal(await chinchiro.recordRoll(db, 'cc6', 'challenger', [[1, 2, 4]]), true);
  assert.equal(await chinchiro.recordRoll(db, 'cc6', 'challenger', [[3, 3, 3]]), false, '二度は振れない');
  assert.equal(await chinchiro.recordRoll(db, 'cc6', 'opponent', [[5, 5, 2]]), true);
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

section('[予想大会]');

const polls = await import(src('lib/polls.js'));

async function makePoll(overrides = {}) {
  return polls.createPoll(db, {
    guildId: G,
    channelId: 'c1',
    ownerId: 'owner',
    question: 'お題',
    options: ['A', 'B', 'C'],
    mode: 'free',
    stake: 0,
    minutes: 60,
    ...overrides,
  });
}

await test('お題と選択肢を作れる', async () => {
  const poll = await makePoll();
  assert.equal(poll.status, 'open');
  const options = await polls.optionsOf(db, poll.id);
  assert.deepEqual(options.map((option) => option.label), ['A', 'B', 'C']);
});

await test('1人1つだけ、あとから変えられない', async () => {
  const poll = await makePoll();
  await eco.setBalance(db, G, 'p1', 1000, 'test');

  assert.deepEqual(await polls.placeBet(db, poll, 'p1', 0, 100), { ok: true });
  assert.equal(await eco.getBalance(db, G, 'p1'), 900, '賭けた分が引かれる');

  const again = await polls.placeBet(db, poll, 'p1', 1, 200);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already');
  assert.equal(await eco.getBalance(db, G, 'p1'), 900, '二重に取られない');
});

await test('残高が足りなければ参加できず、記録も残らない', async () => {
  const poll = await makePoll();
  await eco.setBalance(db, G, 'poor', 50, 'test');
  const result = await polls.placeBet(db, poll, 'poor', 0, 500);
  assert.equal(result.reason, 'insufficient');
  assert.equal(await eco.getBalance(db, G, 'poor'), 50);
  assert.equal(await polls.betOf(db, poll.id, 'poor'), null, '席も取られていない');
});

await test('締切後は参加できない', async () => {
  const poll = await makePoll();
  assert.equal(await polls.closePoll(db, poll.id), true);
  assert.equal(await polls.closePoll(db, poll.id), false, '二重に締め切れない');

  const closed = await polls.getPollById(db, poll.id);
  await eco.setBalance(db, G, 'late', 1000, 'test');
  const result = await polls.placeBet(db, closed, 'late', 0, 100);
  assert.equal(result.reason, 'closed');
  assert.equal(await eco.getBalance(db, G, 'late'), 1000);
});

await test('賭けた額に比例して山分けし、コインの総量は変わらない', async () => {
  const poll = await makePoll();
  const players = { a: 100, b: 200, c: 100, d: 300 };
  for (const [name, amount] of Object.entries(players)) {
    await eco.setBalance(db, G, name, 1000, 'test');
    // a と b が正解（選択肢0）、c と d は外れ
    await polls.placeBet(db, poll, name, ['a', 'b'].includes(name) ? 0 : 1, amount);
  }
  const totalBefore = 4000 - Object.values(players).reduce((sum, amount) => sum + amount, 0);

  const result = await polls.settlePoll(db, poll, 0);
  assert.equal(result.refunded, false);
  assert.equal(result.total, 700);

  // 正解者の賭け金合計は300。a は 700×(100/300)=233、b は 700×(200/300)=466、端数1はbへ
  const a = await eco.getBalance(db, G, 'a');
  const b = await eco.getBalance(db, G, 'b');
  assert.equal(a, 900 + 233);
  assert.equal(b, 800 + 467, '端数は一番多く賭けた人に寄せる');
  assert.equal(await eco.getBalance(db, G, 'c'), 900, '外れた人は戻らない');

  const totalAfter = ['a', 'b', 'c', 'd'].reduce((sum, name) => sum + 0, 0);
  const balances = await Promise.all(['a', 'b', 'c', 'd'].map((name) => eco.getBalance(db, G, name)));
  assert.equal(balances.reduce((sum, value) => sum + value, 0), totalBefore + 700, 'コインは増えも減りもしない');
});

await test('参加費を決めた大会は正解者で等分になる', async () => {
  const poll = await makePoll({ mode: 'fixed', stake: 100 });
  for (const name of ['e', 'f', 'g']) {
    await eco.setBalance(db, G, name, 1000, 'test');
    await polls.placeBet(db, poll, name, name === 'g' ? 1 : 0, 100);
  }
  const result = await polls.settlePoll(db, poll, 0);
  assert.equal(result.total, 300);
  assert.equal(await eco.getBalance(db, G, 'e'), 900 + 150);
  assert.equal(await eco.getBalance(db, G, 'f'), 900 + 150);
  assert.equal(await eco.getBalance(db, G, 'g'), 900);
});

await test('正解者がいなければ全員に返す', async () => {
  const poll = await makePoll();
  for (const name of ['h', 'i']) {
    await eco.setBalance(db, G, name, 1000, 'test');
    await polls.placeBet(db, poll, name, 0, 250);
  }
  const result = await polls.settlePoll(db, poll, 2);
  assert.equal(result.refunded, true);
  assert.equal(await eco.getBalance(db, G, 'h'), 1000);
  assert.equal(await eco.getBalance(db, G, 'i'), 1000);
});

await test('参加者が1人だけなら成立させず返す', async () => {
  const poll = await makePoll();
  await eco.setBalance(db, G, 'solo', 1000, 'test');
  await polls.placeBet(db, poll, 'solo', 0, 400);
  const result = await polls.settlePoll(db, poll, 0);
  assert.equal(result.refunded, true);
  assert.equal(await eco.getBalance(db, G, 'solo'), 1000);
});

await test('山分けは一度だけ', async () => {
  const poll = await makePoll();
  for (const name of ['j', 'k']) {
    await eco.setBalance(db, G, name, 1000, 'test');
    await polls.placeBet(db, poll, name, name === 'j' ? 0 : 1, 100);
  }
  const first = await polls.settlePoll(db, poll, 0);
  assert.equal(first.settled, true);
  const balance = await eco.getBalance(db, G, 'j');

  const again = await polls.settlePoll(db, await polls.getPollById(db, poll.id), 0);
  assert.equal(again.settled, false, '二重に配らない');
  assert.equal(await eco.getBalance(db, G, 'j'), balance);
});

await test('締切が来た大会を拾える', async () => {
  const poll = await makePoll();
  assert.equal((await polls.duePolls(db)).some((row) => row.id === poll.id), false, 'まだ締切前');
  await db.run('UPDATE polls SET closes_at = ?2 WHERE id = ?1', poll.id, Date.now() - 1000);
  assert.equal((await polls.duePolls(db)).some((row) => row.id === poll.id), true);
});

await test('正解が決まらないまま放置された大会は返金して片付ける', async () => {
  const poll = await makePoll();
  await eco.setBalance(db, G, 'm', 1000, 'test');
  await polls.placeBet(db, poll, 'm', 0, 300);
  await polls.closePoll(db, poll.id);

  assert.equal((await polls.abandonedPolls(db)).some((row) => row.id === poll.id), false, 'まだ日が浅い');
  await db.run('UPDATE polls SET closes_at = ?2 WHERE id = ?1', poll.id, Date.now() - polls.ABANDON_MS - 1000);

  const abandoned = await polls.abandonedPolls(db);
  assert.equal(abandoned.some((row) => row.id === poll.id), true);
  assert.equal(await polls.cancelPoll(db, await polls.getPollById(db, poll.id)), true);
  assert.equal(await eco.getBalance(db, G, 'm'), 1000, '返金される');
  assert.equal(await polls.cancelPoll(db, await polls.getPollById(db, poll.id)), false, '二重返金しない');
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

section('[マイグレーションの修復]');

// 0002 の旧版が適用済みのデータベースでも、0003 で正しい形に直ることを確かめる。
// （旧版は連続記録がアクション別ではなく、streaks / streak_rewards に activity 列が無い）
const OLD_0002 = `
CREATE TABLE IF NOT EXISTS streaks (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_date TEXT,
  PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS streak_rewards (
  guild_id TEXT NOT NULL, days INTEGER NOT NULL, reward INTEGER NOT NULL,
  PRIMARY KEY (guild_id, days));
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT,
  description TEXT, condition_type TEXT NOT NULL, threshold INTEGER NOT NULL, activity_name TEXT,
  reward INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_name ON achievements (guild_id, name);
CREATE TABLE IF NOT EXISTS user_achievements (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, achievement_id INTEGER NOT NULL,
  earned_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, achievement_id));
`;

await test('旧版が入ったデータベースでも 0003 で正しい形に直る', async () => {
  const { default: Database } = await import('better-sqlite3');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'migrations');

  const broken = new Database(':memory:');
  broken.exec(fs.readFileSync(path.join(dir, '0001_init.sql'), 'utf8'));
  broken.exec(OLD_0002);
  // 旧版で作られた称号（そのままでは新しいコードで扱えない条件名）
  broken
    .prepare('INSERT INTO achievements (guild_id, name, condition_type, threshold, activity_name, reward, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('g', '筋トレ王', 'activity_reports', 50, '筋トレ', 0, 1);
  broken
    .prepare('INSERT INTO achievements (guild_id, name, condition_type, threshold, activity_name, reward, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('g', '鉄の意志', 'streak', 30, null, 0, 1);
  const oldStreakId = broken.prepare("SELECT id FROM achievements WHERE name = '鉄の意志'").get().id;
  broken.prepare('INSERT INTO user_achievements VALUES (?,?,?,?)').run('g', 'u1', oldStreakId, 1);

  // 実際のデプロイと同じ順で残りを流す
  broken.exec(fs.readFileSync(path.join(dir, '0002_streaks_titles_announcements.sql'), 'utf8'));
  broken.exec(fs.readFileSync(path.join(dir, '0003_repair_streak_tables.sql'), 'utf8'));

  const streakColumns = broken.prepare('PRAGMA table_info(streaks)').all().map((column) => column.name);
  assert.ok(streakColumns.includes('activity'), 'streaks にアクション列がある');
  const rewardColumns = broken.prepare('PRAGMA table_info(streak_rewards)').all().map((column) => column.name);
  assert.ok(rewardColumns.includes('activity'), 'streak_rewards にアクション列がある');

  // アクションごとに記録できる
  broken.prepare('INSERT INTO streaks VALUES (?,?,?,?,?,?)').run('g', 'u1', '筋トレ', 1, 1, '2026-08-27');
  broken.prepare('INSERT INTO streaks VALUES (?,?,?,?,?,?)').run('g', 'u1', '勉強', 2, 2, '2026-08-27');
  assert.equal(broken.prepare('SELECT COUNT(*) AS n FROM streaks').get().n, 2);

  // 称号の条件名が新しくなり、対象を持たない旧「連続日数」は片付く
  assert.equal(broken.prepare("SELECT condition_type FROM achievements WHERE name = '筋トレ王'").get().condition_type, 'activity_count');
  assert.equal(broken.prepare("SELECT COUNT(*) AS n FROM achievements WHERE condition_type = 'streak'").get().n, 0);
  assert.equal(broken.prepare('SELECT COUNT(*) AS n FROM user_achievements WHERE achievement_id = ?').get(oldStreakId).n, 0);

  // 新しく足したテーブルも揃っている
  for (const table of ['profiles', 'announcements']) {
    assert.ok(
      broken.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `${table} がある`,
    );
  }
  broken.close();
});

await test('新規のデータベースでも同じ形になる', async () => {
  const streakColumns = (await db.all('PRAGMA table_info(streaks)')).map((column) => column.name);
  assert.deepEqual(streakColumns.sort(), ['activity', 'best', 'current', 'guild_id', 'last_date', 'user_id']);
  const rewardColumns = (await db.all('PRAGMA table_info(streak_rewards)')).map((column) => column.name);
  assert.deepEqual(rewardColumns.sort(), ['activity', 'from_days', 'guild_id', 'reward', 'to_days']);
});

await test('0004 は既存の「ちょうどN日目」設定をその日だけの範囲に引き継ぐ', async () => {
  const { default: Database } = await import('better-sqlite3');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'migrations');

  const before = new Database(':memory:');
  for (const file of ['0001_init.sql', '0002_streaks_titles_announcements.sql', '0003_repair_streak_tables.sql']) {
    before.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  before.prepare('INSERT INTO streak_rewards (guild_id, activity, days, reward) VALUES (?,?,?,?)').run('g', '筋トレ', 7, 200);

  before.exec(fs.readFileSync(path.join(dir, '0004_streak_reward_ranges.sql'), 'utf8'));

  const migrated = before.prepare('SELECT * FROM streak_rewards').get();
  assert.equal(migrated.from_days, 7);
  assert.equal(migrated.to_days, 7, '前の設定はその日だけの範囲になる');
  assert.equal(migrated.reward, 200);
  before.close();
});

runner.done();
db.close();
