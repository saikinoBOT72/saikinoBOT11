/**
 * Cloudflare の無料枠を今日どれだけ使ったかを表示する。
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/usage.mjs
 *   node scripts/usage.mjs 7      # 7日ぶんさかのぼって1日ずつ出す
 *
 * ふだんは PC を使わずに GitHub の Actions タブから動かせばよい
 * （.github/workflows/usage.yml のボタン）。デプロイ用のトークンで動くのは確認済み。
 *
 * 自分で新しくトークンを作る場合、必要な権限は
 * アカウント → Account Analytics: Read だけ（読むだけなので安全）。
 *
 * 無料枠のリセットは UTC の 0時 = 日本時間の朝9時。
 * なので「今日」は日本時間の朝9時から翌朝9時までのこと。
 */
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DAYS = Math.max(1, Number(process.argv[2] ?? 1));

/** 無料枠。増減したら Cloudflare の料金ページで確かめて直す。 */
const FREE = {
  requests: 100_000,      // Worker のリクエスト（1日）
  rowsRead: 5_000_000,    // D1 が読んだ行（1日）
  rowsWritten: 100_000,   // D1 が書いた行（1日）
};

if (!ACCOUNT || !TOKEN) {
  console.error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を渡してください。');
  process.exit(1);
}

const QUERY = `
  query Usage($account: String!, $since: Date!, $until: Date!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        workersInvocationsAdaptive(
          limit: 1000
          filter: { date_geq: $since, date_leq: $until }
        ) {
          sum { requests errors subrequests }
          dimensions { date scriptName }
        }
        d1AnalyticsAdaptiveGroups(
          limit: 1000
          filter: { date_geq: $since, date_leq: $until }
        ) {
          sum { rowsRead rowsWritten readQueries writeQueries }
          dimensions { date databaseId }
        }
      }
    }
  }
`;

const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const since = day(DAYS - 1);
const until = day(0);

const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: QUERY, variables: { account: ACCOUNT, since, until } }),
});

const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  // トークンが違う・ネットワークが塞がれている等。返ってきたものをそのまま見せる
  console.error(`Cloudflare から JSON 以外が返りました (HTTP ${response.status}):`);
  console.error(text.slice(0, 500));
  process.exit(1);
}
if (json.errors?.length) {
  // 項目名が変わっているとここに出る。そのまま読めば原因が分かる
  console.error('Cloudflare からエラーが返りました:');
  console.error(JSON.stringify(json.errors, null, 2));
  process.exit(1);
}

const account = json.data?.viewer?.accounts?.[0];
if (!account) {
  console.error('アカウントが見つかりません。CLOUDFLARE_ACCOUNT_ID を確かめてください。');
  process.exit(1);
}

/** 日付ごとに足し合わせる。 */
function byDate(rows, pick) {
  const totals = new Map();
  for (const row of rows ?? []) {
    const date = row.dimensions.date;
    const current = totals.get(date) ?? {};
    for (const [key, value] of Object.entries(pick(row))) current[key] = (current[key] ?? 0) + value;
    totals.set(date, current);
  }
  return totals;
}

const workers = byDate(account.workersInvocationsAdaptive, (row) => ({
  requests: row.sum.requests,
  errors: row.sum.errors,
  subrequests: row.sum.subrequests,
}));
const d1 = byDate(account.d1AnalyticsAdaptiveGroups, (row) => ({
  rowsRead: row.sum.rowsRead,
  rowsWritten: row.sum.rowsWritten,
}));

/** 「1,234 / 100,000（1.2%）」の形に。 */
function share(used, limit) {
  const percent = ((used / limit) * 100).toFixed(1);
  const bar = '█'.repeat(Math.min(20, Math.round((used / limit) * 20))).padEnd(20, '·');
  return `${String(used.toLocaleString('ja-JP')).padStart(9)} / ${limit.toLocaleString('ja-JP').padStart(9)}  ${bar} ${percent}%`;
}

const dates = [...new Set([...workers.keys(), ...d1.keys()])].sort().reverse();
if (dates.length === 0) console.log('この期間の記録がまだありません。');

for (const date of dates) {
  const w = workers.get(date) ?? { requests: 0, errors: 0, subrequests: 0 };
  const d = d1.get(date) ?? { rowsRead: 0, rowsWritten: 0 };
  console.log(`\n■ ${date}（UTC）${date === until ? '  ← 進行中' : ''}`);
  console.log(`  リクエスト   ${share(w.requests, FREE.requests)}`);
  console.log(`  D1 読んだ行  ${share(d.rowsRead, FREE.rowsRead)}`);
  console.log(`  D1 書いた行  ${share(d.rowsWritten, FREE.rowsWritten)}`);
  if (w.errors > 0) console.log(`  ⚠️ エラー ${w.errors.toLocaleString('ja-JP')} 件`);
}
console.log('\n※ リセットは UTC 0時（日本時間の朝9時）です。');
