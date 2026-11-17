// 同時押し・お金の出入り・乱数のように、ふつうの操作テストでは見えない壊れ方を見張る。
// 「2台の端末で同時に押す」は Promise.all で2つの操作を同時に走らせて再現する。
import assert from 'node:assert/strict';
import { createRunner, createTestContext, rawInteraction, src } from './harness.mjs';

const { handleComponent } = await import(src('menu/router.js'));
const { Ix } = await import(src('discord/interaction.js'));
const eco = await import(src('lib/economy.js'));
const act = await import(src('lib/activities.js'));
const reporting = await import(src('lib/reporting.js'));
const random = await import(src('lib/random.js'));

const runner = createRunner('[安全]');
const { test, section } = runner;

const GUILD = 'g1';
const ME = 'u1';

function fresh() {
  return createTestContext();
}

async function press(ctx, customId, options = {}) {
  const response = await handleComponent(new Ix(rawInteraction({ customId, ...options })), ctx);
  await ctx.settle();
  return response.json();
}

/** 全員の残高と、履歴の合計が一致しているか（コインが湧いたり消えたりしていないか）。 */
async function assertLedgerMatches(db, where) {
  const balances = await db.all('SELECT user_id, balance FROM balances WHERE guild_id = ?1', GUILD);
  for (const { user_id: userId, balance } of balances) {
    const row = await db.get('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE guild_id = ?1 AND user_id = ?2', GUILD, userId);
    assert.equal(balance, row.total, `${where}: ${userId} の残高 ${balance} と履歴の合計 ${row.total} がずれている`);
  }
}

section('[同時押し]');

await test('ハイ&ローの「降りる」を同時に2回押しても、受け取りは1回', async () => {
  const ctx = fresh();
  await eco.getBalance(ctx.db, GUILD, ME);
  await ctx.db.run(
    `INSERT INTO highlow_games (guild_id, user_id, bet, card_rank, card_suit, multiplier, steps, created_at)
     VALUES (?1, ?2, 100, 7, '♠️', 8, 3, 0)`,
    GUILD,
    ME,
  );
  const before = await eco.getBalance(ctx.db, GUILD, ME);
  await Promise.all([press(ctx, 'm:hl:stop'), press(ctx, 'm:hl:stop')]);
  assert.equal((await eco.getBalance(ctx.db, GUILD, ME)) - before, 800);
  await assertLedgerMatches(ctx.db, 'ハイ&ロー');
});

await test('ハイ&ローで「降りる」と「HIGH」を同時に押しても、受け取ったうえで続くことはない', async () => {
  for (let i = 0; i < 40; i++) {
    const ctx = fresh();
    await eco.getBalance(ctx.db, GUILD, ME);
    await ctx.db.run(
      `INSERT INTO highlow_games (guild_id, user_id, bet, card_rank, card_suit, multiplier, steps, created_at)
       VALUES (?1, ?2, 100, 2, '♠️', 8, 3, 0)`,
      GUILD,
      ME,
    );
    const before = await eco.getBalance(ctx.db, GUILD, ME);
    await Promise.all([press(ctx, 'm:hl:stop'), press(ctx, 'm:hl:pick:high')]);
    const paid = (await eco.getBalance(ctx.db, GUILD, ME)) - before;
    const still = await ctx.db.get('SELECT 1 FROM highlow_games WHERE guild_id = ?1 AND user_id = ?2', GUILD, ME);
    assert.ok(!(paid > 0 && still), `${i}回目: 払い戻し ${paid} を受け取ったのに勝負が残っている`);
    ctx.db.close();
  }
});

await test('運命の扉の「持ち帰る」を同時に2回押しても、受け取りは1回', async () => {
  const ctx = fresh();
  await eco.getBalance(ctx.db, GUILD, ME);
  await ctx.db.run(
    'INSERT INTO doors_games (guild_id, user_id, bet, multiplier, steps, created_at) VALUES (?1, ?2, 100, 8, 3, 0)',
    GUILD,
    ME,
  );
  const before = await eco.getBalance(ctx.db, GUILD, ME);
  await Promise.all([press(ctx, 'm:doors:stop'), press(ctx, 'm:doors:stop')]);
  assert.equal((await eco.getBalance(ctx.db, GUILD, ME)) - before, 800);
  await assertLedgerMatches(ctx.db, '運命の扉');
});

await test('ハイ&ローを同時に2回始めても、賭け金を2回取られない', async () => {
  const ctx = fresh();
  const before = await eco.getBalance(ctx.db, GUILD, ME);
  await Promise.all([press(ctx, 'm:hl:bet:50'), press(ctx, 'm:hl:bet:50')]);
  assert.equal(before - (await eco.getBalance(ctx.db, GUILD, ME)), 50);
  await assertLedgerMatches(ctx.db, 'ハイ&ローの開始');
});

await test('1日1回のアクションを同時に2回報告しても、通るのは1回', async () => {
  const ctx = fresh();
  const activity = await act.upsertActivity(ctx.db, GUILD, { name: '早起き', reward: 30, cooldown_sec: 0, daily_limit: 1 });
  const results = await Promise.all([
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(await act.countToday(ctx.db, GUILD, ME, '早起き', ctx.calendar), 1);
  await assertLedgerMatches(ctx.db, '報告');
});

await test('休憩中のアクションを同時に2回報告しても、通るのは1回', async () => {
  const ctx = fresh();
  const activity = await act.upsertActivity(ctx.db, GUILD, { name: '筋トレ', reward: 50, cooldown_sec: 3600, daily_limit: 0 });
  const results = await Promise.all([
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});

await test('同じ日に2回報告しても、連日ボーナスは1回', async () => {
  const ctx = fresh();
  const streak = await import(src('lib/streak.js'));
  const activity = await act.upsertActivity(ctx.db, GUILD, { name: '勉強', reward: 10, cooldown_sec: 0, daily_limit: 0 });
  await streak.upsertStreakReward(ctx.db, GUILD, '勉強', 1, 0, 100);
  const results = await Promise.all([
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
    reporting.attemptReport(ctx.db, { guildId: GUILD, userId: ME, activity, calendar: ctx.calendar }),
  ]);
  assert.equal(results.filter((result) => result.streakBonus).length, 1);
});

section('[お金の出入り]');

await test('スロットは賭けと払い戻しが1回の処理で、残高と履歴がずれない', async () => {
  const ctx = fresh();
  for (let i = 0; i < 30; i++) await press(ctx, 'm:slot:bet:10');
  await assertLedgerMatches(ctx.db, 'スロット');
});

await test('コイントスも残高と履歴がずれない', async () => {
  const ctx = fresh();
  for (let i = 0; i < 20; i++) await press(ctx, 'm:cf:go:10:heads');
  await assertLedgerMatches(ctx.db, 'コイントス');
});

await test('残高が足りないと、送金は何も動かさない（履歴だけ残ったりしない）', async () => {
  const ctx = fresh();
  await eco.getBalance(ctx.db, GUILD, ME);
  const ledgerBefore = (await ctx.db.get('SELECT COUNT(*) AS n FROM ledger')).n;
  assert.equal(await eco.transfer(ctx.db, GUILD, ME, 'u2', 999999, 'pay'), false);
  const ledgerAfter = (await ctx.db.get('SELECT COUNT(*) AS n FROM ledger')).n;
  // 相手の口座が作られたぶん（初期残高の1行）だけ増える
  assert.ok(ledgerAfter - ledgerBefore <= 1);
  await assertLedgerMatches(ctx.db, '送金の失敗');
});

await test('同時に全額を2回送金しても、マイナスにならない', async () => {
  const ctx = fresh();
  const balance = await eco.getBalance(ctx.db, GUILD, ME);
  const results = await Promise.all([
    eco.transfer(ctx.db, GUILD, ME, 'u2', balance, 'pay'),
    eco.transfer(ctx.db, GUILD, ME, 'u3', balance, 'pay'),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await eco.getBalance(ctx.db, GUILD, ME), 0);
  await assertLedgerMatches(ctx.db, '同時送金');
});

section('[乱数]');

await test('randomInt はどの数もだいたい同じ回数出る', () => {
  const counts = Array(6).fill(0);
  const rolls = 60000;
  for (let i = 0; i < rolls; i++) counts[random.randomInt(6)] += 1;
  for (const count of counts) assert.ok(Math.abs(count - rolls / 6) < rolls / 6 * 0.05, `かたよっている: ${counts}`);
});

await test('shuffle は元の配列を変えず、要素を増やしも減らしもしない', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shuffled = random.shuffle(list);
  assert.deepEqual(list, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), list);
});

await test('src の中で Math.random を使っていない（出目を読まれないように）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
    });
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(text), `${path.relative(root, file)} が Math.random を使っている`);
  }
});

section('[文字の悪用]');

await test('偽リンク・見えない文字・@everyone を整える', async () => {
  const { cleanText, cleanLine } = await import(src('lib/text.js'));
  assert.equal(cleanText('[公式](https://evil.example)'), '公式（https://evil.example）', 'リンク先が見える');
  assert.equal(cleanText('あ\u200Bい\u202Eう'), 'あいう', '見えない文字を消す');
  assert.equal(cleanText('@everyone 集合'), '＠everyone 集合');
  assert.equal(cleanText('👨\u200D👩\u200D👧'), '👨\u200D👩\u200D👧', '絵文字のつなぎは残す');
  assert.equal(cleanLine('1行目\n2行目'), '1行目 2行目', '名前は1行に');
  assert.equal(cleanText('   '), null);
});

await test('現金・電子マネー・ギフト券との交換に見える出品は止める', async () => {
  const { realMoneyWord } = await import(src('lib/text.js'));
  for (const text of ['1000円で買い取ります', '1,000円分', 'PayPayで払います', 'アマギフ 500', 'Amazon ギフト券', '現金と交換']) {
    assert.ok(realMoneyWord(text), `${text} を止めていない`);
  }
  for (const text of ['肩たたき券', '1回おごり', '円陣を組む', 'ギフト（手作り）', '記念トロフィー']) {
    assert.equal(realMoneyWord(text), null, `${text} まで止めている`);
  }

  const ctx = fresh();
  const response = await handleComponent(
    new Ix(rawInteraction({ type: 5, customId: 'm:shop:create:consumable', fields: { name: '500円', price: '10', description: '', stock: '', image_url: '' } })),
    ctx,
  );
  assert.match(JSON.stringify(await response.json()), /受け付けていません/);
  assert.equal((await ctx.db.get('SELECT COUNT(*) AS n FROM shop_items')).n, 0, '出品されていない');
});

await test('Bot の投稿は、指定が無ければ @everyone やロールに通知を飛ばさない', async () => {
  const { withSafeMentions } = await import(src('discord/rest.js'));
  assert.deepEqual(withSafeMentions({ content: '@everyone' }).allowed_mentions, { parse: ['users'] });
  assert.deepEqual(withSafeMentions({ allowed_mentions: { parse: [] } }).allowed_mentions, { parse: [] }, '指定があればそのまま');
  const { reply } = await import(src('discord/respond.js'));
  assert.deepEqual((await reply({ content: 'x' }).json()).data.allowed_mentions, { parse: ['users'] });
});

await test('src に見えない文字がそのまま入っていない', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
    });
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const found = text.match(/[\u00AD\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u);
    assert.equal(found, null, `${path.relative(root, file)} に見えない文字 U+${found?.[0].codePointAt(0).toString(16)} がある`);
  }
});

section('[エラーと投稿の失敗]');

await test('チャンネルに投稿できなかったら、押した本人にだけ伝え、エラーとして記録する', async () => {
  const ctx = fresh();
  const ix = new Ix(rawInteraction({ customId: 'm:slot:bet:10' }));
  ctx.ix = ix;
  ctx.failPosts.on = true;
  ctx.announce('c1', { content: 'テスト' });
  await ctx.settle();
  assert.equal(ctx.followups.length, 1, '本人に一言');
  assert.match(ctx.followups[0].content, /投稿できませんでした/);
  const recorded = await ctx.db.get('SELECT * FROM error_reports WHERE guild_id = ?1', GUILD);
  assert.equal(recorded.place, 'チャンネルへの投稿');
});

await test('エラーの記録には長いIDやURLを残さず、同じものは1行にまとめる', async () => {
  const { describeError, recordError, recentErrors } = await import(src('lib/error-report.js'));
  const text = describeError(new Error('Discord API POST /channels/123456789012345678/messages (403) https://discord.com/x Bot abcdefghijklmnopqrstuvwxyz'));
  assert.doesNotMatch(text, /123456789012345678|https:|abcdefghijklmnop/);

  const ctx = fresh();
  await recordError(ctx.db, GUILD, 'テスト', new Error('id 111111111111111111 が無い'));
  await recordError(ctx.db, GUILD, 'テスト', new Error('id 222222222222222222 が無い'));
  const rows = await recentErrors(ctx.db, GUILD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

await test('管理用チャンネルへのお知らせは、同じエラーなら間をあける', async () => {
  const { recordError } = await import(src('lib/error-report.js'));
  const ctx = fresh();
  await eco.getSettings(ctx.db, GUILD);
  await ctx.db.run("UPDATE guild_settings SET log_channel_id = 'log1' WHERE guild_id = ?1", GUILD);
  assert.equal(await recordError(ctx.db, GUILD, '場所', new Error('こわれた'), 1_000_000), 'log1', '1回目は知らせる');
  assert.equal(await recordError(ctx.db, GUILD, '場所', new Error('こわれた'), 1_000_000 + 60_000), null, 'すぐ後は知らせない');
  assert.equal(await recordError(ctx.db, GUILD, '場所', new Error('こわれた'), 1_000_000 + 31 * 60_000), 'log1', '30分たてばまた知らせる');
});

section('[版の表示]');

await test('新しい版になったら、管理用チャンネルに一度だけ知らせる', async () => {
  const ctx = fresh();
  const cron = await import(src('cron.js'));
  await eco.getSettings(ctx.db, GUILD);
  await ctx.db.run("UPDATE guild_settings SET log_channel_id = 'log1' WHERE guild_id = ?1", GUILD);
  ctx.env = { BUILD_SHA: 'abc1234', BUILD_TIME: '2026-11-17T00:00:00Z', BUILD_NOTE: 'テストの変更' };

  await cron.announceNewVersion(ctx);
  const posted = ctx.sent.filter((entry) => entry.channelId === 'log1');
  assert.equal(posted.length, 1);
  assert.match(JSON.stringify(posted[0].payload), /abc1234/);
  assert.match(JSON.stringify(posted[0].payload), /テストの変更/);

  await cron.announceNewVersion(ctx);
  assert.equal(ctx.sent.filter((entry) => entry.channelId === 'log1').length, 1, '同じ版では二度知らせない');

  ctx.env = { BUILD_SHA: 'def5678' };
  await cron.announceNewVersion(ctx);
  assert.equal(ctx.sent.filter((entry) => entry.channelId === 'log1').length, 2, '次の版でまた知らせる');
});

await test('版が分からないとき（手元で動かしたとき）は何もしない', async () => {
  const { claimNewVersion, describeVersion } = await import(src('lib/version.js'));
  const ctx = fresh();
  assert.equal(await claimNewVersion(ctx.db, {}), false);
  assert.match(describeVersion({}), /不明/);
});

section('[履歴の表示]');

await test('お金を動かすときの理由は、すべて日本語で表示できる', async () => {
  const { reasonText } = await import(src('lib/ledger-reasons.js'));
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
    });
  const reasons = new Set(['initial', 'report', 'pay', 'streak', 'achievement', 'ranking']);
  const ACTION = '(?:bet|ante|call|double|escrow|win|refund|buy|sell|bonus|give|take|set|send|receive)';
  for (const file of walk(root)) {
    for (const found of fs.readFileSync(file, 'utf8').matchAll(new RegExp(`'([a-z]+:${ACTION})'`, 'g'))) reasons.add(found[1]);
  }
  // 1対1のゲームは `${duel.game}:bet` の形で書くので、ゲームの名前から作る
  for (const game of ['rr', 'cs', 'mine', 'doors']) for (const action of ['bet', 'refund']) reasons.add(`${game}:${action}`);

  assert.ok(reasons.size > 40, `見張れた理由が少なすぎる: ${reasons.size}`);
  for (const reason of reasons) {
    const text = reasonText(reason);
    assert.doesNotMatch(text, /[a-z]+:[a-z]+/, `${reason} が英語のまま出る`);
    assert.notEqual(text, reason, `${reason} の日本語が無い`);
  }
});

runner.done();
